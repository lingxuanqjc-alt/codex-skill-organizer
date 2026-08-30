using System.Diagnostics;

namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal static class McpLauncher
{
    public static async Task<int> RunAsync(IReadOnlyList<string> arguments)
    {
        var layout = InstallLayout.Resolve();
        if (!File.Exists(layout.McpSidecarPath))
        {
            throw new FileNotFoundException(App.Text("MissingMcpSidecar"));
        }

        var startInfo = new ProcessStartInfo(layout.NodePath)
        {
            UseShellExecute = false,
            WorkingDirectory = layout.InstallRoot,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(layout.McpSidecarPath);
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        startInfo.Environment["CSO_INSTALL_ROOT"] = layout.InstallRoot;

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException(App.Text("McpStartFailed"));
        await process.WaitForExitAsync().ConfigureAwait(false);
        return process.ExitCode;
    }
}
