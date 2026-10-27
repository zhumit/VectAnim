using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Serialization;

/// <summary>
/// Structural validation of path data (WPF Path Mini-Language).
///
/// WPF <c>Geometry.Parse</c> is lenient about trailing garbage (for example "M 0,0 X 1,1" parses only the first half),
/// which surfaces in a description file as a shape that mysteriously lost a segment. A strict character-level scan runs first.
/// </summary>
internal static class PathDataValidator
{
    private const string CommandLetters = "MmLlHhVvCcSsQqTtAaZz";

    public static bool TryValidate(string? data, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(data))
        {
            error = Strings.T("PathData.Empty");
            return false;
        }

        var text = data.Trim();

        // Optional fill-rule prefix: F0 = EvenOdd, F1 = Nonzero
        if (text.Length >= 2 && (text[0] == 'F' || text[0] == 'f') && (text[1] == '0' || text[1] == '1'))
        {
            text = text.Substring(2).TrimStart();
        }

        if (text.Length == 0)
        {
            error = Strings.T("PathData.Empty");
            return false;
        }

        if (text[0] != 'M' && text[0] != 'm')
        {
            error = Strings.T("PathData.MustStartWithMove");
            return false;
        }

        var hasCommand = false;
        foreach (var character in text)
        {
            if (char.IsWhiteSpace(character) || character == ',')
            {
                continue;
            }

            if (CommandLetters.IndexOf(character) >= 0)
            {
                hasCommand = true;
                continue;
            }

            if (char.IsDigit(character) || character is '.' or '-' or '+' or 'e' or 'E')
            {
                continue;
            }

            error = Strings.T("PathData.UnrecognizedCharacter", character);
            return false;
        }

        if (!hasCommand)
        {
            error = Strings.T("PathData.MissingCommand");
            return false;
        }

        return true;
    }
}
