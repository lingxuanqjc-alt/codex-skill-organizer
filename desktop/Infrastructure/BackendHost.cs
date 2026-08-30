using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal sealed record BackendSession(
    int ProcessId,
    string Token,
    string ProtocolVersion,
    Uri WorkbenchUri);

internal sealed class BackendHost : IAsyncDisposable
{
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan CredentialReuseMargin = TimeSpan.FromSeconds(1);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly HttpClient _httpClient;
    private readonly string _dataRoot;
    private readonly bool _reuseExistingDescriptors;
    private readonly bool _requireExactVersion;
    private readonly bool _internalHealthCheck;
    private readonly string _desktopLeaseId = Guid.NewGuid().ToString("N");
    private Process? _ownedProcess;
    private string? _ownedToken;
    private BackendSession? _session;
    private long _desktopLeaseGeneration;
    private bool _disposed;

    public BackendHost()
        : this(DataRoot, reuseExistingDescriptors: true, requireExactVersion: false, internalHealthCheck: false)
    {
    }

    private BackendHost(
        string dataRoot,
        bool reuseExistingDescriptors,
        bool requireExactVersion,
        bool internalHealthCheck)
    {
        _dataRoot = internalHealthCheck ? ResolveHealthCheckDataRoot(dataRoot) : DataRoot;
        _reuseExistingDescriptors = reuseExistingDescriptors;
        _requireExactVersion = requireExactVersion;
        _internalHealthCheck = internalHealthCheck;
        var handler = new SocketsHttpHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            ConnectTimeout = HealthTimeout,
        };
        _httpClient = new HttpClient(handler)
        {
            Timeout = HealthTimeout,
        };
        Directory.CreateDirectory(_dataRoot);
        if (_internalHealthCheck)
        {
            EnsurePhysicalHealthCheckBoundary(_dataRoot);
        }
    }

    public static string DataRoot { get; } = ResolveDataRoot();

    internal static BackendHost CreateHealthCheck(string dataRoot) =>
        new(
            dataRoot,
            reuseExistingDescriptors: false,
            requireExactVersion: true,
            internalHealthCheck: true);

    public bool IsReady => _session is not null;

    public void ReleaseOwnedProcess()
    {
        var process = _ownedProcess;
        _ownedProcess = null;
        _ownedToken = null;
        process?.Dispose();
    }

    public async Task<BackendSession> EnsureReadyAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_reuseExistingDescriptors)
            {
                var existing = await ProbeDescriptorsAsync(cancellationToken).ConfigureAwait(false);
                if (existing is not null)
                {
                    _session = existing;
                    return existing;
                }
            }

            var layout = InstallLayout.Resolve();
            var startInfo = new ProcessStartInfo(layout.NodePath)
            {
                UseShellExecute = false,
                WorkingDirectory = layout.InstallRoot,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add(layout.ServerPath);
            startInfo.Environment["CSO_INSTALL_ROOT"] = layout.InstallRoot;
            startInfo.Environment["CSO_DESKTOP_PID"] = Environment.ProcessId.ToString();
            if (_internalHealthCheck)
            {
                startInfo.ArgumentList.Add("--internal-health-check");
                startInfo.Environment["CSO_INTERNAL_HEALTH_DATA_ROOT"] = _dataRoot;
                startInfo.Environment["CSO_INTERNAL_HEALTH_PARENT_PID"] = Environment.ProcessId.ToString();
            }

            var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException(App.Text("ServiceStartFailed"));
            _ownedProcess = process;

            try
            {
                var deadline = DateTimeOffset.UtcNow + StartupTimeout;
                while (DateTimeOffset.UtcNow < deadline)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (process.HasExited)
                    {
                        throw new InvalidOperationException(string.Format(App.Text("ServiceExitedFormat"), process.ExitCode));
                    }

                    var session = await ProbeDescriptorsAsync(cancellationToken).ConfigureAwait(false);
                    if (session is not null)
                    {
                        if (session.ProcessId == process.Id)
                        {
                            _ownedToken = session.Token;
                        }
                        else
                        {
                            await TerminateExactProcessAsync(process).ConfigureAwait(false);
                            _ownedProcess = null;
                        }

                        _session = session;
                        return session;
                    }
                    await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                }

                throw new TimeoutException(App.Text("ServiceTimeout"));
            }
            catch
            {
                await TerminateExactProcessAsync(process).ConfigureAwait(false);
                _ownedProcess = null;
                _ownedToken = null;
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask StopOwnedProcessAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var process = _ownedProcess;
            if (process is null)
            {
                _session = null;
                return;
            }

            var descriptor = await FindDescriptorForOwnedProcessAsync(process.Id).ConfigureAwait(false);
            if (descriptor is null
                || string.IsNullOrEmpty(_ownedToken)
                || !CryptographicEquals(descriptor.Token, _ownedToken))
            {
                return;
            }

            await TerminateExactProcessAsync(process).ConfigureAwait(false);
            process.Dispose();
            _ownedProcess = null;
            _ownedToken = null;
            _session = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<BackendSession?> SetDesktopLeaseAsync(
        bool active,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var generation = Interlocked.Increment(ref _desktopLeaseGeneration);
        BackendSession? session;
        if (active)
        {
            session = await EnsureReadyAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                session = _session;
            }
            finally
            {
                _gate.Release();
            }
        }

        // A hide/show transition can complete out of order around backend
        // startup. Only the newest desired visibility state may reach the server.
        if (session is null || generation != Interlocked.Read(ref _desktopLeaseGeneration))
        {
            return session;
        }

        var origin = $"http://127.0.0.1:{session.WorkbenchUri.Port}";
        using var request = new HttpRequestMessage(HttpMethod.Put, $"{origin}/api/desktop-lease")
        {
            Content = JsonContent.Create(new
            {
                leaseId = _desktopLeaseId,
                active,
                generation,
            }),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", session.Token);
        request.Headers.TryAddWithoutValidation("Origin", origin);
        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(App.Text("ServiceStartFailed"));
        }
        return session;
    }

    public async Task DetachSharedServiceAsync()
    {
        try
        {
            await SetDesktopLeaseAsync(active: false, CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            // The server-side lease has a short TTL, so a failed best-effort
            // release cannot keep the shared service alive indefinitely.
        }
        ReleaseOwnedProcess();
        _session = null;
    }

    public async Task StopCompatibleServiceAsync()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            foreach (var descriptorPath in DescriptorPaths)
            {
                var descriptor = await TryReadDescriptorAsync(descriptorPath, CancellationToken.None).ConfigureAwait(false);
                if (descriptor is null || !IsValidDescriptorBoundary(descriptor))
                {
                    continue;
                }

                if (!TryResolveOwnedNodePath(descriptor.InstallRoot, out var expectedNodePath))
                {
                    throw new InvalidOperationException("The running Organizer service is outside the installed product boundary.");
                }

                Process process;
                try
                {
                    process = Process.GetProcessById(descriptor.Pid);
                    var actualProcessPath = process.MainModule?.FileName;
                    if (string.IsNullOrWhiteSpace(actualProcessPath)
                        || !Path.GetFullPath(actualProcessPath).Equals(expectedNodePath, StringComparison.OrdinalIgnoreCase))
                    {
                        process.Dispose();
                        throw new InvalidOperationException("The running service PID is not the bundled Organizer runtime.");
                    }
                }
                catch (ArgumentException)
                {
                    await DeleteDescriptorIfUnchangedAsync(descriptorPath, descriptor.Token).ConfigureAwait(false);
                    continue;
                }

                await TerminateExactProcessAsync(process).ConfigureAwait(false);
                process.Dispose();
                await DeleteDescriptorIfUnchangedAsync(descriptorPath, descriptor.Token).ConfigureAwait(false);
            }
            _session = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<BackendSession?> ProbeDescriptorsAsync(CancellationToken cancellationToken)
    {
        ProtocolMismatchException? mismatch = null;
        foreach (var descriptorPath in DescriptorPaths)
        {
            var descriptor = await TryReadDescriptorAsync(descriptorPath, cancellationToken).ConfigureAwait(false);
            if (descriptor is null || !IsValidDescriptorBoundary(descriptor))
            {
                continue;
            }

            try
            {
                var health = await ProbeHealthAsync(descriptor, cancellationToken).ConfigureAwait(false);
                if (health is null)
                {
                    continue;
                }

                if (!ProtocolContract.IsCompatible(
                        descriptor.ProtocolVersion,
                        descriptor.ProtocolMin,
                        descriptor.ProtocolMax)
                    || !ProtocolContract.IsCompatible(
                        health.ProtocolVersion,
                        health.ProtocolMin,
                        health.ProtocolMax)
                    || !string.Equals(descriptor.ProtocolVersion, health.ProtocolVersion, StringComparison.OrdinalIgnoreCase))
                {
                    mismatch = new ProtocolMismatchException(health.ProtocolVersion ?? descriptor.ProtocolVersion ?? "unknown");
                    continue;
                }

                if (_requireExactVersion)
                {
                    var expectedVersion = ExpectedProductVersion;
                    if (!string.Equals(descriptor.Version, expectedVersion, StringComparison.Ordinal)
                        || !string.Equals(health.Version, expectedVersion, StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            $"Health check expected product {expectedVersion}, but the backend reported {health.Version ?? descriptor.Version ?? "unknown"}.");
                    }
                }

                return new BackendSession(
                    descriptor.Pid,
                    descriptor.Token,
                    health.ProtocolVersion!,
                    new Uri($"http://127.0.0.1:{descriptor.Port}/#bootstrap={Uri.EscapeDataString(descriptor.Token)}"));
            }
            catch (HttpRequestException)
            {
                // A stale descriptor is expected after an interrupted backend process.
            }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // A stale or unhealthy backend is retried by starting the fixed bundled runtime.
            }
        }

        if (mismatch is not null)
        {
            throw mismatch;
        }
        return null;
    }

    private async Task<RuntimeDescriptor?> FindDescriptorForOwnedProcessAsync(int processId)
    {
        foreach (var descriptorPath in DescriptorPaths)
        {
            var descriptor = await TryReadDescriptorAsync(descriptorPath, CancellationToken.None).ConfigureAwait(false);
            if (descriptor?.Pid == processId)
            {
                return descriptor;
            }
        }
        return null;
    }

    private async Task<HealthResponse?> ProbeHealthAsync(
        RuntimeDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"http://127.0.0.1:{descriptor.Port}/api/health");
        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var health = await response.Content.ReadFromJsonAsync<HealthResponse>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return health is { Ok: true, Service: "codex-skill-organizer" }
            && health.Pid == descriptor.Pid
            ? health
            : null;
    }

    private static bool IsValidDescriptorBoundary(RuntimeDescriptor descriptor) =>
        descriptor.Service == "codex-skill-organizer"
        && descriptor.Host == "127.0.0.1"
        && descriptor.Port is > 0 and <= 65535
        && descriptor.Pid > 0
        && !string.IsNullOrWhiteSpace(descriptor.Token)
        && descriptor.CredentialExpiresAt
            > (DateTimeOffset.UtcNow + CredentialReuseMargin).ToUnixTimeMilliseconds();

    private static async Task<RuntimeDescriptor?> TryReadDescriptorAsync(
        string descriptorPath,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(descriptorPath))
        {
            return null;
        }

        try
        {
            await using var stream = new FileStream(
                descriptorPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 4096,
                useAsync: true);
            return await JsonSerializer.DeserializeAsync<RuntimeDescriptor>(stream, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (IOException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static async Task TerminateExactProcessAsync(Process process)
    {
        try
        {
            if (process.HasExited)
            {
                return;
            }
            process.Kill(entireProcessTree: true);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (InvalidOperationException)
        {
            // The exact child already exited.
        }
        catch (OperationCanceledException)
        {
            // Do not broaden termination if the exact child does not exit promptly.
        }
    }

    private static async Task DeleteDescriptorIfUnchangedAsync(string descriptorPath, string expectedToken)
    {
        var current = await TryReadDescriptorAsync(descriptorPath, CancellationToken.None).ConfigureAwait(false);
        if (current is null || !CryptographicEquals(current.Token, expectedToken))
        {
            return;
        }

        try
        {
            File.Delete(descriptorPath);
        }
        catch (FileNotFoundException)
        {
            // The exact service removed its own descriptor while exiting.
        }
    }

    private static bool CryptographicEquals(string left, string right)
    {
        var leftBytes = System.Text.Encoding.UTF8.GetBytes(left);
        var rightBytes = System.Text.Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private IEnumerable<string> DescriptorPaths
    {
        get
        {
            yield return Path.Combine(_dataRoot, "runtime.json");
            yield return Path.Combine(_dataRoot, "runtime", "runtime.json");
        }
    }

    private static string ResolveDataRoot()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SkillOrganizerForCodex");
    }

    private static string ResolveHealthCheckDataRoot(string dataRoot)
    {
        if (string.IsNullOrWhiteSpace(dataRoot) || !Path.IsPathFullyQualified(dataRoot))
        {
            throw new ArgumentException("Health-check data root must be an absolute path.", nameof(dataRoot));
        }
        var candidate = Path.GetFullPath(dataRoot);
        var expectedParent = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "SkillOrganizerForCodex-health"));
        if (candidate.StartsWith(@"\\", StringComparison.Ordinal)
            || !string.Equals(Path.GetDirectoryName(candidate), expectedParent, StringComparison.OrdinalIgnoreCase)
            || !Guid.TryParseExact(Path.GetFileName(candidate), "N", out _))
        {
            throw new ArgumentException(
                "Health-check data root must be a generated direct child of the local Organizer health directory.",
                nameof(dataRoot));
        }
        return candidate;
    }

    private static void EnsurePhysicalHealthCheckBoundary(string dataRoot)
    {
        foreach (var candidate in new[] { Path.GetDirectoryName(dataRoot)!, dataRoot })
        {
            var attributes = File.GetAttributes(candidate);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("Health-check data root cannot traverse a reparse point.");
            }
        }
    }

    private static bool TryResolveOwnedNodePath(string? installRoot, out string nodePath)
    {
        nodePath = string.Empty;
        if (string.IsNullOrWhiteSpace(installRoot) || !Path.IsPathFullyQualified(installRoot))
        {
            return false;
        }
        var candidateRoot = Path.GetFullPath(installRoot);
        var currentLayout = InstallLayout.Resolve();
        var currentRoot = Path.GetFullPath(currentLayout.InstallRoot);
        var currentDirectory = new DirectoryInfo(currentRoot);
        var productRoot = currentDirectory.Parent?.Name.Equals("versions", StringComparison.OrdinalIgnoreCase) == true
            ? currentDirectory.Parent.Parent?.FullName
            : currentRoot;
        if (string.IsNullOrWhiteSpace(productRoot))
        {
            return false;
        }
        var versionsRoot = Path.GetFullPath(Path.Combine(productRoot, "versions"));
        if (!candidateRoot.StartsWith(Path.TrimEndingDirectorySeparator(versionsRoot) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase)
            || !Path.GetDirectoryName(candidateRoot)!.Equals(versionsRoot, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        var candidateNodePath = Path.GetFullPath(Path.Combine(candidateRoot, "runtime", "node.exe"));
        if (!File.Exists(candidateNodePath))
        {
            return false;
        }
        nodePath = candidateNodePath;
        return true;
    }

    internal static string ExpectedProductVersion
    {
        get
        {
            var informational = typeof(BackendHost).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion;
            return string.IsNullOrWhiteSpace(informational)
                ? "unknown"
                : informational.Split('+', 2)[0];
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        await StopOwnedProcessAsync().ConfigureAwait(false);
        if (_ownedProcess is { } remainingOwnedProcess)
        {
            await TerminateExactProcessAsync(remainingOwnedProcess).ConfigureAwait(false);
            remainingOwnedProcess.Dispose();
            _ownedProcess = null;
            _ownedToken = null;
            _session = null;
        }
        _disposed = true;
        _httpClient.Dispose();
        _gate.Dispose();
    }

    private sealed record RuntimeDescriptor(
        [property: JsonPropertyName("service")] string? Service,
        [property: JsonPropertyName("version")] string? Version,
        [property: JsonPropertyName("protocolVersion")] string? ProtocolVersion,
        [property: JsonPropertyName("protocolMin")] string? ProtocolMin,
        [property: JsonPropertyName("protocolMax")] string? ProtocolMax,
        [property: JsonPropertyName("host")] string? Host,
        [property: JsonPropertyName("port")] int Port,
        [property: JsonPropertyName("token")] string Token,
        [property: JsonPropertyName("pid")] int Pid,
        [property: JsonPropertyName("credentialExpiresAt")] long CredentialExpiresAt,
        [property: JsonPropertyName("startedAt")] string? StartedAt,
        [property: JsonPropertyName("installRoot")] string? InstallRoot);

    private sealed record HealthResponse(
        [property: JsonPropertyName("ok")] bool Ok,
        [property: JsonPropertyName("service")] string? Service,
        [property: JsonPropertyName("version")] string? Version,
        [property: JsonPropertyName("protocolVersion")] string? ProtocolVersion,
        [property: JsonPropertyName("protocolMin")] string? ProtocolMin,
        [property: JsonPropertyName("protocolMax")] string? ProtocolMax,
        [property: JsonPropertyName("pid")] int Pid);
}
