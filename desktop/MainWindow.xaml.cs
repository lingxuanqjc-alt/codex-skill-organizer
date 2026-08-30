using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using SkillOrganizerForCodex.Desktop.Infrastructure;
using Forms = System.Windows.Forms;

namespace SkillOrganizerForCodex.Desktop;

public partial class MainWindow : Window
{
    private readonly BackendHost _backend;
    private readonly Func<Task> _requestExit;
    private readonly Forms.NotifyIcon _trayIcon;
    private readonly DispatcherTimer _leaseTimer;
    private CancellationTokenSource _visibilityCancellation = new();
    private Task _visibleLoadTask = Task.CompletedTask;
    private long _visibilityGeneration;
    private bool _isWindowVisible;
    private Uri? _workbenchUri;
    private bool _isExiting;
    private bool _webViewReady;
    private TaskCompletionSource<bool>? _navigationCompletion;
    private ulong? _navigationId;

    internal MainWindow(BackendHost backend, Func<Task> requestExit)
    {
        _backend = backend;
        _requestExit = requestExit;
        InitializeComponent();

        _trayIcon = CreateTrayIcon();
        _leaseTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromSeconds(30),
        };
        _leaseTimer.Tick += LeaseTimer_OnTick;

        Loaded += async (_, _) => await StartVisibleWorkbenchLoad().ConfigureAwait(true);
    }

    public void ShowAndActivate()
    {
        Show();
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
        _ = StartVisibleWorkbenchLoad();
    }

    public void PrepareForExit()
    {
        if (_isExiting)
        {
            return;
        }
        _isExiting = true;
        _leaseTimer.Stop();
        _visibilityCancellation.Cancel();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_isExiting)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        base.OnClosing(e);
    }

    private Forms.NotifyIcon CreateTrayIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        var icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
        var tray = new Forms.NotifyIcon
        {
            Icon = icon,
            Text = App.Text("WindowTitle"),
            Visible = true,
        };

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add(App.Text("TrayShow"), null, (_, _) => Dispatcher.Invoke(ShowAndActivate));
        menu.Items.Add(App.Text("TrayRescan"), null, async (_, _) => await PostWorkbenchCommandAsync("organizer:rescan").ConfigureAwait(true));
        menu.Items.Add(App.Text("TrayManagement"), null, async (_, _) => await PostWorkbenchCommandAsync("organizer:management").ConfigureAwait(true));
        menu.Items.Add(App.Text("TrayStartupSettings"), null, async (_, _) => await PostWorkbenchCommandAsync("organizer:startup-settings").ConfigureAwait(true));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(App.Text("TrayExit"), null, async (_, _) => await Dispatcher.InvokeAsync(_requestExit).Task.Unwrap().ConfigureAwait(true));
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => Dispatcher.Invoke(ShowAndActivate);
        return tray;
    }

    private Task StartVisibleWorkbenchLoad()
    {
        var (generation, cancellationToken) = BeginVisibilityState(visible: true);
        _visibleLoadTask = LoadWorkbenchAsync(generation, cancellationToken);
        return _visibleLoadTask;
    }

    private async Task LoadWorkbenchAsync(long generation, CancellationToken cancellationToken)
    {
        SetLoadingState();
        try
        {
            var session = await _backend.SetDesktopLeaseAsync(active: true, cancellationToken).ConfigureAwait(true)
                ?? throw new InvalidOperationException(App.Text("ServiceStartFailed"));
            if (!IsCurrentVisibleOperation(generation, cancellationToken)) return;
            _workbenchUri = session.WorkbenchUri;

            if (Environment.GetEnvironmentVariable("CSO_FORCE_BROWSER") == "1")
            {
                ShowBrowserFallback(App.Text("BrowserFallbackForced"));
                OpenInDefaultBrowser();
                return;
            }

            await EnsureWebViewAsync().ConfigureAwait(true);
            if (!IsCurrentVisibleOperation(generation, cancellationToken)) return;
            WorkbenchWebView.Visibility = Visibility.Visible;
            _navigationCompletion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _navigationId = null;
            WorkbenchWebView.Source = _workbenchUri;
            await _navigationCompletion.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken).ConfigureAwait(true);
            if (!IsCurrentVisibleOperation(generation, cancellationToken)) return;
            StatusPanel.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // A newer show/hide generation owns the UI and lease state.
        }
        catch (ProtocolMismatchException error)
        {
            if (IsCurrentVisibleOperation(generation, cancellationToken))
                ShowFailure(App.Text("ProtocolMismatchTitle"), error.Message, allowBrowser: false);
        }
        catch (BrowserFallbackException error)
        {
            if (IsCurrentVisibleOperation(generation, cancellationToken))
            {
                ShowBrowserFallback(string.Format(App.Text("WebViewFallbackFormat"), error.Message));
                OpenInDefaultBrowser();
            }
        }
        catch (Exception error)
        {
            if (IsCurrentVisibleOperation(generation, cancellationToken))
                ShowFailure(App.Text("LaunchFailed"), error.Message, allowBrowser: _workbenchUri is not null);
        }
    }

    private async Task EnsureWebViewAsync()
    {
        if (_webViewReady)
        {
            return;
        }

        try
        {
            var userDataFolder = Path.Combine(BackendHost.DataRoot, "webview2");
            Directory.CreateDirectory(userDataFolder);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder).ConfigureAwait(true);
            await WorkbenchWebView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

            var core = WorkbenchWebView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.PermissionRequested += (_, eventArgs) => eventArgs.State = CoreWebView2PermissionState.Deny;
            core.NavigationStarting += CoreWebView2_OnNavigationStarting;
            core.NavigationCompleted += CoreWebView2_OnNavigationCompleted;
            core.NewWindowRequested += CoreWebView2_OnNewWindowRequested;
            _webViewReady = true;
        }
        catch (Exception error)
        {
            throw new BrowserFallbackException(error);
        }
    }

    private void CoreWebView2_OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsTrustedWorkbenchUri(e.Uri))
        {
            _navigationId = e.NavigationId;
            return;
        }

        e.Cancel = true;
        OpenExternalUri(e.Uri);
    }

    private void CoreWebView2_OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!IsTrustedWorkbenchUri(e.Uri))
        {
            OpenExternalUri(e.Uri);
        }
    }

    private void CoreWebView2_OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_navigationId != e.NavigationId)
        {
            return;
        }
        if (e.IsSuccess)
        {
            _navigationCompletion?.TrySetResult(true);
            return;
        }

        _navigationCompletion?.TrySetException(new InvalidOperationException(
            string.Format(App.Text("NavigationFailedFormat"), e.WebErrorStatus)));
    }

    private bool IsTrustedWorkbenchUri(string rawUri)
    {
        if (_workbenchUri is null || !Uri.TryCreate(rawUri, UriKind.Absolute, out var candidate))
        {
            return false;
        }

        return candidate.Scheme == Uri.UriSchemeHttp
            && candidate.Host.Equals("127.0.0.1", StringComparison.Ordinal)
            && candidate.Port == _workbenchUri.Port;
    }

    private async Task PostWorkbenchCommandAsync(string commandType)
    {
        ShowAndActivate();
        await _visibleLoadTask.ConfigureAwait(true);

        if (WorkbenchWebView.CoreWebView2 is not null)
        {
            WorkbenchWebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = commandType }));
        }
    }

    private async void LeaseTimer_OnTick(object? sender, EventArgs e)
    {
        var generation = _visibilityGeneration;
        var cancellationToken = _visibilityCancellation.Token;
        if (!IsCurrentVisibleOperation(generation, cancellationToken))
        {
            return;
        }
        try
        {
            await _backend.SetDesktopLeaseAsync(active: true, cancellationToken).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // A hide or newer wake-up generation superseded this continuation.
        }
        catch
        {
            // The next renewal or explicit wake-up retries through the stable backend host.
        }
    }

    private void HideToTray()
    {
        Hide();
        var (_, cancellationToken) = BeginVisibilityState(visible: false);
        _visibleLoadTask = Task.CompletedTask;
        _ = ReleaseDesktopLeaseAsync(cancellationToken);
    }

    private (long Generation, CancellationToken CancellationToken) BeginVisibilityState(bool visible)
    {
        _visibilityCancellation.Cancel();
        _visibilityCancellation.Dispose();
        _visibilityCancellation = new CancellationTokenSource();
        _isWindowVisible = visible;
        var generation = ++_visibilityGeneration;
        if (visible) _leaseTimer.Start();
        else _leaseTimer.Stop();
        return (generation, _visibilityCancellation.Token);
    }

    private bool IsCurrentVisibleOperation(long generation, CancellationToken cancellationToken) =>
        !_isExiting
        && _isWindowVisible
        && generation == _visibilityGeneration
        && !cancellationToken.IsCancellationRequested;

    private async Task ReleaseDesktopLeaseAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _backend.SetDesktopLeaseAsync(active: false, cancellationToken).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // A newer visible generation will publish a higher lease generation.
        }
        catch
        {
            // A missed release expires server-side and never kills a shared process.
        }
    }

    private void SetLoadingState()
    {
        WorkbenchWebView.Visibility = Visibility.Collapsed;
        StatusPanel.Visibility = Visibility.Visible;
        StatusTitle.Text = App.Text("LoadingTitle");
        StatusDetail.Text = App.Text("LoadingDetail");
        RetryButton.Visibility = Visibility.Collapsed;
        OpenBrowserButton.Visibility = Visibility.Collapsed;
    }

    private void ShowFailure(string title, string detail, bool allowBrowser)
    {
        WorkbenchWebView.Visibility = Visibility.Collapsed;
        StatusPanel.Visibility = Visibility.Visible;
        StatusTitle.Text = title;
        StatusDetail.Text = detail;
        RetryButton.Visibility = Visibility.Visible;
        OpenBrowserButton.Visibility = allowBrowser ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ShowBrowserFallback(string detail)
    {
        ShowFailure(App.Text("BrowserFallbackTitle"), detail, allowBrowser: true);
    }

    private void OpenInDefaultBrowser()
    {
        if (_workbenchUri is not null)
        {
            Process.Start(new ProcessStartInfo(_workbenchUri.AbsoluteUri) { UseShellExecute = true });
        }
    }

    private static void OpenExternalUri(string rawUri)
    {
        if (Uri.TryCreate(rawUri, UriKind.Absolute, out var uri)
            && IsAllowedExternalUri(uri))
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
    }

    private static bool IsAllowedExternalUri(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttps
        || uri.Scheme == Uri.UriSchemeHttp
        || (uri.Scheme.Equals("codex", StringComparison.OrdinalIgnoreCase)
            && uri.Host.Equals("plugins", StringComparison.OrdinalIgnoreCase)
            && uri.AbsolutePath.Equals("/codex-skill-organizer", StringComparison.OrdinalIgnoreCase));

    private async void RetryButton_OnClick(object sender, RoutedEventArgs e) =>
        await StartVisibleWorkbenchLoad().ConfigureAwait(true);

    private void OpenBrowserButton_OnClick(object sender, RoutedEventArgs e) => OpenInDefaultBrowser();

    private sealed class BrowserFallbackException(Exception innerException) : Exception(innerException.Message, innerException);
}
