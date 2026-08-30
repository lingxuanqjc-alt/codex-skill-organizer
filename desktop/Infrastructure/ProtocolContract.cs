namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal static class ProtocolContract
{
    public const string Current = "2.0";
    public const string Minimum = "2.0";
    public const string Maximum = "2.x";

    public static bool IsCompatible(
        string? remoteCurrent,
        string? remoteMinimum,
        string? remoteMaximum)
    {
        if (!TryParse(remoteCurrent, upperBound: false, out var remote)
            || !TryParse(Minimum, upperBound: false, out var localMinimum)
            || !TryParse(Maximum, upperBound: true, out var localMaximum)
            || remote < localMinimum
            || remote > localMaximum)
        {
            return false;
        }

        if (!TryParse(remoteMinimum, upperBound: false, out var requiredMinimum)
            || !TryParse(remoteMaximum, upperBound: true, out var requiredMaximum)
            || !TryParse(Current, upperBound: false, out var localCurrent)
            || localCurrent < requiredMinimum
            || localCurrent > requiredMaximum)
        {
            return false;
        }
        return true;
    }

    private static bool TryParse(string? value, bool upperBound, out Version version)
    {
        version = new Version(0, 0);
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        if (value.EndsWith(".x", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(value[..^2], out var major))
        {
            version = new Version(major, upperBound ? int.MaxValue : 0);
            return true;
        }

        return Version.TryParse(value, out version!);
    }
}

internal sealed class ProtocolMismatchException(string remoteVersion)
    : Exception(string.Format(App.Text("ProtocolMismatchFormat"), remoteVersion, ProtocolContract.Maximum));
