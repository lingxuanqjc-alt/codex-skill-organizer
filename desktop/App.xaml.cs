using System.Globalization;
using System.Windows;
using SkillOrganizerForCodex.Desktop.Infrastructure;

namespace SkillOrganizerForCodex.Desktop;

public partial class App : System.Windows.Application
{
    private static readonly TimeSpan[] PendingPluginRetryDelays =
    [
        TimeSpan.Zero,
        TimeSpan.FromSeconds(5),
        TimeSpan.FromSeconds(30),
        TimeSpan.FromMinutes(2),
    ];
    private static readonly TimeSpan CappedPendingPluginRetryDelay = TimeSpan.FromMinutes(10);

    private SingleInstanceCoordinator? _singleInstance;
    private BackendHost? _backend;
    private MainWindow? _mainWindow;
    private readonly SemaphoreSlim _pluginInstallGate = new(1, 1);
    private readonly CancellationTokenSource _lifecycleCancellation = new();
    private bool _normalExit;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        LoadLocalizedResources();

        var forwardResult = StableLauncher.TryForwardToCurrentVersion(e.Args, out var launchError, out var forwardedExitCode);
        if (forwardResult != StableLaunchResult.NotApplicable)
        {
            if (forwardResult == StableLaunchResult.Failed)
            {
                ReportHeadlessOrUiError(e.Args, launchError ?? Text("LaunchFailed"));
                Shutdown(2);
            }
            else
            {
                Shutdown(forwardedExitCode);
            }
            return;
        }

        if (e.Args.Contains("--mcp", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await RunMcpAsync(e.Args).ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        if (e.Args.Contains("--shutdown-for-maintenance", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await RunMaintenanceShutdownAsync().ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        if (e.Args.Contains("--headless", StringComparer.OrdinalIgnoreCase)
            && e.Args.Contains("--ensure-service", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await RunEnsureServiceAsync().ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        if (e.Args.Contains("--health-check", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await RunHealthCheckAsync(e.Args).ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        if (e.Args.Contains("--complete-plugin-install", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await PluginInstaller.CompleteAsync(e.Args).ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        if (e.Args.Contains("--remove-plugin-install", StringComparer.OrdinalIgnoreCase))
        {
            var exitCode = await PluginInstaller.RemoveFromCodexAsync(e.Args).ConfigureAwait(true);
            Shutdown(exitCode);
            return;
        }

        try
        {
            _singleInstance = new SingleInstanceCoordinator();
            if (!_singleInstance.IsPrimary)
            {
                var activated = await _singleInstance.TryActivatePrimaryAsync().ConfigureAwait(true);
                if (!activated)
                {
                    System.Windows.MessageBox.Show(
                        Text("ActivationFailed"),
                        Text("WindowTitle"),
                        MessageBoxButton.OK,
                        MessageBoxImage.Warning);
                }
                Shutdown(activated ? 0 : 3);
                return;
            }

            _backend = new BackendHost();
            _mainWindow = new MainWindow(_backend, RequestExitAsync);
            _singleInstance.ActivationRequested += (_, _) => Dispatcher.Invoke(() =>
            {
                _mainWindow.ShowAndActivate();
                _ = TryCompletePendingPluginInstallAsync(e.Args, _lifecycleCancellation.Token);
            });
            _singleInstance.StartListening();
            MainWindow = _mainWindow;
            _mainWindow.Show();
            _ = RetryPendingPluginInstallWithBackoffAsync(e.Args, _lifecycleCancellation.Token);
        }
        catch (Exception error)
        {
            System.Windows.MessageBox.Show(
                string.Format(CultureInfo.CurrentCulture, Text("LaunchFailureFormat"), error.Message),
                Text("LaunchFailed"),
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            await DisposeServicesAsync().ConfigureAwait(true);
            Shutdown(1);
        }
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        _normalExit = true;
        _lifecycleCancellation.Cancel();
        _mainWindow?.PrepareForExit();
        _backend?.DetachSharedServiceAsync().GetAwaiter().GetResult();
        base.OnSessionEnding(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _normalExit = true;
        _lifecycleCancellation.Cancel();
        _mainWindow?.PrepareForExit();
        DisposeServicesAsync().AsTask().GetAwaiter().GetResult();
        base.OnExit(e);
    }

    private async Task<int> RunMcpAsync(string[] args)
    {
        try
        {
            if (PluginInstaller.HasPendingInstall)
            {
                var completionCode = await PluginInstaller.CompleteAsync(args).ConfigureAwait(true);
                if (completionCode is PluginInstaller.ReplacementPendingExitCode or PluginInstaller.MarketplaceSafetyExitCode)
                {
                    Console.Error.WriteLine("Organizer plugin replacement is still pending; the existing verified MCP bridge will continue.");
                }
            }
            var forwardedArguments = args
                .SkipWhile(argument => !argument.Equals("--mcp", StringComparison.OrdinalIgnoreCase))
                .Skip(1)
                .ToArray();
            return await McpLauncher.RunAsync(forwardedArguments).ConfigureAwait(true);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private async Task RetryPendingPluginInstallWithBackoffAsync(
        string[] arguments,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; !cancellationToken.IsCancellationRequested; attempt++)
        {
            var delay = attempt < PendingPluginRetryDelays.Length
                ? PendingPluginRetryDelays[attempt]
                : CappedPendingPluginRetryDelay;
            try
            {
                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                }
                if (await TryCompletePendingPluginInstallAsync(arguments, cancellationToken).ConfigureAwait(false))
                {
                    return;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private async Task<bool> TryCompletePendingPluginInstallAsync(
        string[] arguments,
        CancellationToken cancellationToken)
    {
        if (!PluginInstaller.HasPendingInstall)
        {
            return true;
        }

        var gateAcquired = false;
        try
        {
            await _pluginInstallGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            gateAcquired = true;
            if (!PluginInstaller.HasPendingInstall)
            {
                return true;
            }
            var completionCode = await PluginInstaller.CompleteAsync(arguments).ConfigureAwait(false);
            if (completionCode == 0)
            {
                return true;
            }
            System.Diagnostics.Trace.TraceWarning(
                "Organizer plugin installation remains pending (code {0}).",
                completionCode);
            return false;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception error)
        {
            System.Diagnostics.Trace.TraceError(
                "Organizer plugin background completion failed: {0}",
                error.Message);
            return false;
        }
        finally
        {
            if (gateAcquired)
            {
                _pluginInstallGate.Release();
            }
        }
    }

    private async Task<int> RunHealthCheckAsync(string[] arguments)
    {
        var healthRoot = Path.Combine(
            Path.GetTempPath(),
            "SkillOrganizerForCodex-health",
            Guid.NewGuid().ToString("N"));
        try
        {
            await using var backend = BackendHost.CreateHealthCheck(healthRoot);
            await SeedHealthDatabaseAsync(arguments, healthRoot).ConfigureAwait(true);
            await backend.EnsureReadyAsync().ConfigureAwait(true);
            await backend.StopOwnedProcessAsync().ConfigureAwait(true);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally
        {
            TryDeleteHealthRoot(healthRoot);
        }
    }

    private static async Task SeedHealthDatabaseAsync(IReadOnlyList<string> arguments, string healthRoot)
    {
        var resultPath = ReadOption(arguments, "--upgrade-backup-result");
        if (resultPath is null)
        {
            return;
        }
        if (!Path.IsPathFullyQualified(resultPath) || !File.Exists(resultPath))
        {
            throw new InvalidDataException("The upgrade backup result is missing or is not an absolute file path.");
        }

        await using var resultStream = new FileStream(
            Path.GetFullPath(resultPath),
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            useAsync: true);
        var result = await System.Text.Json.JsonSerializer.DeserializeAsync<UpgradeBackupResult>(
                resultStream,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            .ConfigureAwait(true);
        if (result is null
            || result.SchemaVersion != 1
            || !string.Equals(result.Version, BackendHost.ExpectedProductVersion, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The upgrade backup result does not match this application version.");
        }
        if (!result.SourceExisted)
        {
            if (result.BackupRelativePath is not null)
            {
                throw new InvalidDataException("The upgrade backup result is internally inconsistent.");
            }
            return;
        }
        if (string.IsNullOrWhiteSpace(result.BackupRelativePath)
            || Path.IsPathFullyQualified(result.BackupRelativePath))
        {
            throw new InvalidDataException("The upgrade backup path is invalid.");
        }

        var dataRoot = Path.GetFullPath(Path.GetDirectoryName(resultPath)!);
        var backupRoot = Path.GetFullPath(Path.Combine(dataRoot, "upgrade-backups"));
        var backupPath = Path.GetFullPath(Path.Combine(dataRoot, result.BackupRelativePath));
        if (!backupPath.StartsWith(Path.TrimEndingDirectorySeparator(backupRoot) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase)
            || !File.Exists(backupPath))
        {
            throw new InvalidDataException("The verified upgrade backup is outside its allowed directory or missing.");
        }

        Directory.CreateDirectory(healthRoot);
        File.Copy(backupPath, Path.Combine(healthRoot, "organizer.db"), overwrite: false);
    }

    private static string? ReadOption(IReadOnlyList<string> arguments, string option)
    {
        for (var index = 0; index < arguments.Count; index++)
        {
            if (!arguments[index].Equals(option, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (index + 1 >= arguments.Count || arguments[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"{option} requires a value.");
            }
            return arguments[index + 1];
        }
        return null;
    }

    private static void TryDeleteHealthRoot(string healthRoot)
    {
        try
        {
            var parent = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "SkillOrganizerForCodex-health"));
            var candidate = Path.GetFullPath(healthRoot);
            if (candidate.StartsWith(Path.TrimEndingDirectorySeparator(parent) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase)
                && Path.GetFileName(candidate).Length == 32)
            {
                Directory.Delete(candidate, recursive: true);
            }
        }
        catch (IOException)
        {
            // A failed cleanup is harmless and remains confined to the generated health-check directory.
        }
        catch (UnauthorizedAccessException)
        {
            // A failed cleanup is harmless and remains confined to the generated health-check directory.
        }
    }

    private sealed record UpgradeBackupResult(
        int SchemaVersion,
        string Version,
        bool SourceExisted,
        string? BackupRelativePath,
        DateTimeOffset CreatedAt);

    private async Task<int> RunEnsureServiceAsync()
    {
        using var bootstrapMutex = new Mutex(
            initiallyOwned: false,
            $"Local\\SkillOrganizerForCodex.BackendBootstrap.{Environment.UserName}");
        var ownsMutex = false;
        await using var backend = new BackendHost();
        try
        {
            try
            {
                ownsMutex = bootstrapMutex.WaitOne(TimeSpan.FromSeconds(45));
            }
            catch (AbandonedMutexException)
            {
                ownsMutex = true;
            }
            if (!ownsMutex)
            {
                throw new TimeoutException(Text("ServiceTimeout"));
            }
            await backend.EnsureReadyAsync().ConfigureAwait(true);
            backend.ReleaseOwnedProcess();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            await backend.StopOwnedProcessAsync().ConfigureAwait(true);
            return 1;
        }
        finally
        {
            if (ownsMutex) bootstrapMutex.ReleaseMutex();
        }
    }

    private static async Task<int> RunMaintenanceShutdownAsync()
    {
        await using var backend = new BackendHost();
        try
        {
            await backend.StopCompatibleServiceAsync().ConfigureAwait(true);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private async Task RequestExitAsync()
    {
        if (_normalExit)
        {
            return;
        }

        _normalExit = true;
        _mainWindow?.PrepareForExit();
        await DisposeServicesAsync().ConfigureAwait(true);
        Shutdown(0);
    }

    private async ValueTask DisposeServicesAsync()
    {
        if (_backend is not null)
        {
            await _backend.DetachSharedServiceAsync().ConfigureAwait(true);
            await _backend.DisposeAsync().ConfigureAwait(true);
            _backend = null;
        }

        _singleInstance?.Dispose();
        _singleInstance = null;
    }

    private void LoadLocalizedResources()
    {
        var language = CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase)
            ? "zh-CN"
            : "en-US";
        Resources.MergedDictionaries.Clear();
        Resources.MergedDictionaries.Add(new ResourceDictionary
        {
            Source = new Uri($"Localization/Strings.{language}.xaml", UriKind.Relative),
        });
    }

    internal static string Text(string key) =>
        Current.TryFindResource(key) as string ?? key;

    private static void ReportHeadlessOrUiError(string[] args, string message)
    {
        if (args.Any(argument => argument.Equals("--health-check", StringComparison.OrdinalIgnoreCase)
            || argument.Equals("--mcp", StringComparison.OrdinalIgnoreCase)
            || argument.Equals("--headless", StringComparison.OrdinalIgnoreCase)
            || argument.Equals("--shutdown-for-maintenance", StringComparison.OrdinalIgnoreCase)
            || argument.Equals("--complete-plugin-install", StringComparison.OrdinalIgnoreCase)
            || argument.Equals("--remove-plugin-install", StringComparison.OrdinalIgnoreCase)))
        {
            Console.Error.WriteLine(message);
            return;
        }

        System.Windows.MessageBox.Show(message, Text("LaunchFailed"), MessageBoxButton.OK, MessageBoxImage.Error);
    }
}
