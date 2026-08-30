namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal sealed record InstallLayout(
    string InstallRoot,
    string NodePath,
    string ServerPath,
    string McpSidecarPath)
{
    private const int MaximumParentDepth = 8;

    public static InstallLayout Resolve() => Resolve(AppContext.BaseDirectory, File.Exists);

    internal static InstallLayout Resolve(string baseDirectory, Func<string, bool> fileExists)
    {
        if (string.IsNullOrWhiteSpace(baseDirectory) || !Path.IsPathFullyQualified(baseDirectory))
        {
            throw new ArgumentException("Install layout base directory must be absolute.", nameof(baseDirectory));
        }

        ArgumentNullException.ThrowIfNull(fileExists);
        var directory = new DirectoryInfo(Path.GetFullPath(baseDirectory));
        for (var depth = 0; depth <= MaximumParentDepth && directory is not null; depth++, directory = directory.Parent)
        {
            var installRoot = directory.FullName;
            var serverPath = FirstExisting(
                fileExists,
                Path.Combine(installRoot, "app", "dist", "server.mjs"),
                Path.Combine(installRoot, "dist", "server.mjs"));
            if (serverPath is null)
            {
                continue;
            }

            var nodePath = Path.Combine(installRoot, "runtime", "node.exe");
            if (!fileExists(nodePath))
            {
                continue;
            }

            return new InstallLayout(
                installRoot,
                Path.GetFullPath(nodePath),
                Path.GetFullPath(serverPath),
                Path.GetFullPath(Path.Combine(Path.GetDirectoryName(serverPath)!, "mcp-sidecar.mjs")));
        }

        throw new FileNotFoundException(App.Text("NoInstallLayout"));
    }

    private static string? FirstExisting(Func<string, bool> fileExists, params string[] candidates) =>
        candidates.FirstOrDefault(fileExists);
}
