using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal enum StableLaunchResult
{
    NotApplicable,
    Forwarded,
    Failed,
}

internal static class StableLauncher
{
    private const int CurrentSchemaVersion = 1;
    private const string PointerFileName = "current.json";

    public static StableLaunchResult TryForwardToCurrentVersion(
        string[] arguments,
        out string? error,
        out int exitCode)
    {
        error = null;
        exitCode = 0;
        var productRoot = Path.GetFullPath(AppContext.BaseDirectory);
        var pointerPath = Path.Combine(productRoot, PointerFileName);
        if (!File.Exists(pointerPath))
        {
            return StableLaunchResult.NotApplicable;
        }

        try
        {
            var pointer = JsonSerializer.Deserialize<CurrentVersionPointer>(
                File.ReadAllText(pointerPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (pointer is null
                || pointer.SchemaVersion != CurrentSchemaVersion
                || string.IsNullOrWhiteSpace(pointer.Version)
                || !IsSafeRelativeDirectory(pointer.RelativePath))
            {
                throw new InvalidDataException(App.Text("InvalidCurrentPointer"));
            }

            var relativePath = pointer.RelativePath.Replace('/', Path.DirectorySeparatorChar);
            var versionDirectory = Path.GetFullPath(Path.Combine(productRoot, relativePath));
            if (!IsDescendant(productRoot, versionDirectory)
                || !Path.GetFileName(versionDirectory).Equals(pointer.Version, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(App.Text("InvalidCurrentPointer"));
            }

            var targetPath = Path.Combine(versionDirectory, "SkillOrganizerForCodex.exe");
            if (!File.Exists(targetPath)
                || (Environment.ProcessPath is { } processPath
                    && Path.GetFullPath(targetPath).Equals(processPath, StringComparison.OrdinalIgnoreCase)))
            {
                throw new FileNotFoundException(App.Text("CurrentVersionMissing"));
            }

            var startInfo = new ProcessStartInfo(targetPath)
            {
                UseShellExecute = false,
                WorkingDirectory = versionDirectory,
                CreateNoWindow = true,
            };
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException(App.Text("CurrentVersionMissing"));
            if (arguments.Any(IsSynchronousMode))
            {
                process.WaitForExit();
                exitCode = process.ExitCode;
            }
            return StableLaunchResult.Forwarded;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            exitCode = 2;
            return StableLaunchResult.Failed;
        }
    }

    private static bool IsSynchronousMode(string argument) =>
        argument.Equals("--health-check", StringComparison.OrdinalIgnoreCase)
        || argument.Equals("--mcp", StringComparison.OrdinalIgnoreCase)
        || argument.Equals("--headless", StringComparison.OrdinalIgnoreCase)
        || argument.Equals("--shutdown-for-maintenance", StringComparison.OrdinalIgnoreCase)
        || argument.Equals("--complete-plugin-install", StringComparison.OrdinalIgnoreCase)
        || argument.Equals("--remove-plugin-install", StringComparison.OrdinalIgnoreCase);

    private static bool IsSafeRelativeDirectory(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathFullyQualified(relativePath))
        {
            return false;
        }

        var segments = relativePath.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 2
            && segments[0].Equals("versions", StringComparison.OrdinalIgnoreCase)
            && segments.All(segment => segment is not "." and not ".." && segment.IndexOfAny(Path.GetInvalidFileNameChars()) < 0);
    }

    private static bool IsDescendant(string root, string candidate)
    {
        var normalizedRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
        return candidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
    }

    private sealed record CurrentVersionPointer(
        [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
        [property: JsonPropertyName("version")] string Version,
        [property: JsonPropertyName("relativePath")] string RelativePath);
}
