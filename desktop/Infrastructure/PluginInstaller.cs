using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal static class PluginInstaller
{
    public const int MissingCliExitCode = 20;
    public const int AddFailedExitCode = 21;
    public const int ReplacementPendingExitCode = 22;
    public const int MarketplaceSafetyExitCode = 23;
    public const int RemoveFailedExitCode = 24;

    private const int HelperPendingExitCode = 75;
    private const string PluginId = "codex-skill-organizer@personal";
    private const string ProductId = "codex-skill-organizer";
    private static readonly TimeSpan ValidationTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(1);
    private static readonly string PendingPath = Path.Combine(BackendHost.DataRoot, "plugin-install-pending.json");
    private static readonly string LegacyConsentPath = Path.Combine(BackendHost.DataRoot, "plugin-legacy-adoption-consent.v1.json");

    public static bool HasPendingInstall =>
        File.Exists(PendingPath)
        || File.Exists(Path.Combine(BackendHost.DataRoot, "plugin-update-pending.json"));

    public static async Task<int> CompleteAsync(string[] arguments)
    {
        var helperResult = await CompleteMarketplacePendingAsync().ConfigureAwait(false);
        if (helperResult.ExitCode == HelperPendingExitCode)
        {
            await WritePendingAsync("plugin_source_replacement_pending").ConfigureAwait(false);
            return ReplacementPendingExitCode;
        }
        if (helperResult.ExitCode != 0)
        {
            await WritePendingAsync($"marketplace_helper_{helperResult.ExitCode}").ConfigureAwait(false);
            return MarketplaceSafetyExitCode;
        }

        var explicitPath = ReadExplicitCliPath(arguments);
        var cliPath = await FindCodexCliAsync(explicitPath).ConfigureAwait(false);
        if (cliPath is null)
        {
            await WritePendingAsync("codex_cli_missing").ConfigureAwait(false);
            Console.Error.WriteLine(App.Text("CodexCliMissing"));
            return MissingCliExitCode;
        }

        try
        {
            var addResult = await RunProcessAsync(cliPath, ["plugin", "add", PluginId], InstallTimeout)
                .ConfigureAwait(false);
            if (addResult.ExitCode != 0)
            {
                await WritePendingAsync(addResult.TimedOut ? "codex_plugin_add_timeout" : "codex_plugin_add_failed")
                    .ConfigureAwait(false);
                return AddFailedExitCode;
            }

            if (!await IsExpectedPluginInstalledAsync(cliPath).ConfigureAwait(false))
            {
                await WritePendingAsync("codex_plugin_verification_failed").ConfigureAwait(false);
                return AddFailedExitCode;
            }

            WriteRegisteredMarker();
            TryDeleteFile(PendingPath);
            TryDeleteFile(LegacyConsentPath);
            return 0;
        }
        catch
        {
            await WritePendingAsync("codex_plugin_add_failed").ConfigureAwait(false);
            return AddFailedExitCode;
        }
    }

    public static async Task<int> RemoveFromCodexAsync(string[] arguments)
    {
        var explicitPath = ReadExplicitCliPath(arguments);
        var cliPath = await FindCodexCliAsync(explicitPath).ConfigureAwait(false);
        if (cliPath is null)
        {
            return MissingCliExitCode;
        }

        try
        {
            if (!await IsPluginInstalledAsync(cliPath, expectedVersion: null).ConfigureAwait(false))
            {
                return 0;
            }
            var removeResult = await RunProcessAsync(
                    cliPath,
                    ["plugin", "remove", PluginId, "--json"],
                    InstallTimeout)
                .ConfigureAwait(false);
            if (removeResult.ExitCode != 0
                || await IsPluginInstalledAsync(cliPath, expectedVersion: null).ConfigureAwait(false))
            {
                return RemoveFailedExitCode;
            }
            return 0;
        }
        catch
        {
            return RemoveFailedExitCode;
        }
    }

    private static async Task<ProcessResult> CompleteMarketplacePendingAsync()
    {
        try
        {
            var layout = InstallLayout.Resolve();
            var helperPath = Path.Combine(layout.InstallRoot, "tools", "manage-personal-marketplace.mjs");
            if (!File.Exists(helperPath))
            {
                return new ProcessResult(66, false, string.Empty);
            }
            var arguments = new List<string>
            {
                helperPath,
                "complete-pending",
                "--marketplace", MarketplacePath,
                "--plugin-destination", PluginDestination,
                "--data-dir", BackendHost.DataRoot,
                "--version", BackendHost.ExpectedProductVersion,
                "--adopt-legacy-0.1.1", HasValidLegacyConsent() ? "true" : "false",
            };
            return await RunProcessAsync(layout.NodePath, arguments, InstallTimeout).ConfigureAwait(false);
        }
        catch
        {
            return new ProcessResult(76, false, string.Empty);
        }
    }

    private static string MarketplacePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".agents", "plugins", "marketplace.json");

    private static string PluginDestination => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "plugins", ProductId);

    private static string? ReadExplicitCliPath(IReadOnlyList<string> arguments)
    {
        for (var index = 0; index < arguments.Count; index++)
        {
            if (!arguments[index].Equals("--codex-cli", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            return index + 1 < arguments.Count ? arguments[index + 1] : string.Empty;
        }
        return null;
    }

    private static async Task<string?> FindCodexCliAsync(string? explicitPath)
    {
        if (explicitPath is not null)
        {
            return Path.IsPathFullyQualified(explicitPath)
                && File.Exists(explicitPath)
                && await IsCodexCliAsync(explicitPath).ConfigureAwait(false)
                    ? Path.GetFullPath(explicitPath)
                    : null;
        }

        var candidates = new List<string?>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WindowsApps", "codex.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Codex", "codex.exe"),
        };

        var codexBinRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenAI", "Codex", "bin");
        if (Directory.Exists(codexBinRoot))
        {
            candidates.AddRange(Directory
                .EnumerateFiles(codexBinRoot, "codex.exe", new EnumerationOptions
                {
                    RecurseSubdirectories = true,
                    MaxRecursionDepth = 1,
                    IgnoreInaccessible = true,
                })
                .OrderByDescending(File.GetLastWriteTimeUtc));
        }

        foreach (var candidate in candidates
                     .Where(candidate => !string.IsNullOrWhiteSpace(candidate))
                     .Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Path.IsPathFullyQualified(candidate!) || !File.Exists(candidate))
            {
                continue;
            }
            if (await IsCodexCliAsync(candidate!).ConfigureAwait(false))
            {
                return Path.GetFullPath(candidate!);
            }
        }
        return null;
    }

    private static async Task<bool> IsCodexCliAsync(string candidate)
    {
        try
        {
            var result = await RunProcessAsync(candidate, ["--version"], ValidationTimeout).ConfigureAwait(false);
            return result.ExitCode == 0
                && result.StandardOutput.StartsWith("codex-cli ", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> IsExpectedPluginInstalledAsync(string cliPath) =>
        await IsPluginInstalledAsync(cliPath, BackendHost.ExpectedProductVersion).ConfigureAwait(false);

    private static async Task<bool> IsPluginInstalledAsync(string cliPath, string? expectedVersion)
    {
        var result = await RunProcessAsync(cliPath, ["plugin", "list", "--json"], InstallTimeout)
            .ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            return false;
        }
        try
        {
            using var document = JsonDocument.Parse(result.StandardOutput);
            if (!document.RootElement.TryGetProperty("installed", out var installed)
                || installed.ValueKind != JsonValueKind.Array)
            {
                return false;
            }
            foreach (var item in installed.EnumerateArray())
            {
                if (item.TryGetProperty("pluginId", out var pluginId)
                    && pluginId.GetString() == PluginId
                    && item.TryGetProperty("installed", out var isInstalled)
                    && isInstalled.ValueKind == JsonValueKind.True
                    && (expectedVersion is null
                        || item.TryGetProperty("version", out var version)
                        && version.GetString() == expectedVersion))
                {
                    return true;
                }
            }
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string executable,
        IEnumerable<string> arguments,
        TimeSpan timeoutValue)
    {
        var startInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException(App.Text("PluginInstallFailed"));
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(timeoutValue);
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
            await Task.WhenAll(outputTask, errorTask).ConfigureAwait(false);
            return new ProcessResult(1, true, string.Empty);
        }
        var output = await outputTask.ConfigureAwait(false);
        await errorTask.ConfigureAwait(false);
        return new ProcessResult(process.ExitCode, false, output);
    }

    private static bool HasValidLegacyConsent()
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(LegacyConsentPath));
            var root = document.RootElement;
            return root.TryGetProperty("schemaVersion", out var schemaVersion)
                && schemaVersion.GetInt32() == 1
                && root.TryGetProperty("pluginId", out var pluginId)
                && pluginId.GetString() == PluginId
                && root.TryGetProperty("fromVersion", out var fromVersion)
                && fromVersion.GetString() == "0.1.1"
                && root.TryGetProperty("toVersion", out var toVersion)
                && toVersion.GetString() == BackendHost.ExpectedProductVersion
                && root.TryGetProperty("authorized", out var authorized)
                && authorized.ValueKind == JsonValueKind.True;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    private static async Task WritePendingAsync(string reasonCode)
    {
        Directory.CreateDirectory(BackendHost.DataRoot);
        var pending = new PendingPluginInstall(1, PluginId, reasonCode, DateTimeOffset.UtcNow);
        var temporaryPath = PendingPath + $".{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllTextAsync(
                temporaryPath,
                JsonSerializer.Serialize(pending, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine)
            .ConfigureAwait(false);
        File.Move(temporaryPath, PendingPath, overwrite: true);
    }

    private static void WriteRegisteredMarker()
    {
        var layout = InstallLayout.Resolve();
        var versionDirectory = new DirectoryInfo(layout.InstallRoot);
        var productRoot = versionDirectory.Parent?.Name.Equals("versions", StringComparison.OrdinalIgnoreCase) == true
            ? versionDirectory.Parent.Parent?.FullName
            : null;
        if (string.IsNullOrWhiteSpace(productRoot))
        {
            throw new InvalidOperationException("Installed product root could not be resolved.");
        }
        var markerPath = Path.Combine(productRoot, "plugin-registered.marker");
        var temporaryPath = markerPath + $".{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporaryPath, BackendHost.ExpectedProductVersion + Environment.NewLine);
        File.Move(temporaryPath, markerPath, overwrite: true);
    }

    private static void TryDeleteFile(string filePath)
    {
        try
        {
            File.Delete(filePath);
        }
        catch (IOException)
        {
            // A successful verified operation is authoritative; stale marker cleanup is retryable.
        }
        catch (UnauthorizedAccessException)
        {
            // A successful verified operation is authoritative; stale marker cleanup is retryable.
        }
    }

    private sealed record ProcessResult(int ExitCode, bool TimedOut, string StandardOutput);

    private sealed record PendingPluginInstall(
        [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
        [property: JsonPropertyName("pluginId")] string PluginId,
        [property: JsonPropertyName("reasonCode")] string ReasonCode,
        [property: JsonPropertyName("createdAt")] DateTimeOffset CreatedAt);
}
