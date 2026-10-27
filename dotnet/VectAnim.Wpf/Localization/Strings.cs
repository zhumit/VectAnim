using System.Globalization;

namespace VectAnim.Wpf.Localization;

/// <summary>
/// Lightweight string table used by the whole library.
///
/// There are no satellite assemblies and no <c>.resx</c> files: the two tables
/// (<see cref="Table"/> for English and <see cref="StringsZhCn.Table"/> for Simplified
/// Chinese) are plain dictionaries compiled into the assembly. This keeps the NuGet
/// package single-file friendly and makes the lookup predictable on industrial PCs
/// where the OS UI language may not match the language the HMI is authored in.
///
/// The active language defaults to English and can be overridden either through the
/// <c>VECTANIM_LANG</c> environment variable (<c>en</c>, <c>zh</c> or <c>zh-CN</c>) or
/// at runtime through <see cref="Culture"/>. Unknown values fall back to English.
/// </summary>
public static partial class Strings
{
    private const string ChineseLanguage = "zh-CN";
    private const string EnglishLanguage = "en";

    private static CultureInfo _culture = ResolveDefaultCulture();

    /// <summary>
    /// Active UI language. Only <c>en</c> and <c>zh-CN</c> are supported; any other
    /// value is normalized to <c>en</c>.
    /// </summary>
    public static CultureInfo Culture
    {
        get => _culture;
        set => _culture = Normalize(value?.Name);
    }

    /// <summary>
    /// Keys that exist in the English table but are missing from the active table.
    /// Useful for diagnostics and for catching incomplete translations.
    /// </summary>
    public static IReadOnlyCollection<string> MissingKeys
    {
        get
        {
            var table = ActiveTable;
            if (ReferenceEquals(table, Table))
            {
                return Array.Empty<string>();
            }

            var missing = new List<string>();
            foreach (var key in Table.Keys)
            {
                if (!table.ContainsKey(key))
                {
                    missing.Add(key);
                }
            }

            return missing;
        }
    }

    /// <summary>
    /// All keys of the English table. This is the reference set: every other table is expected
    /// to cover exactly these keys.
    /// </summary>
    public static IReadOnlyCollection<string> Keys => Table.Keys;

    /// <summary>
    /// Looks up <paramref name="key"/> in the active table, falls back to English and
    /// finally to the key itself. When <paramref name="args"/> is supplied the result is
    /// formatted with <see cref="string.Format(string, object[])"/>.
    /// </summary>
    public static string T(string key, params object[] args)
    {
        if (string.IsNullOrEmpty(key))
        {
            return string.Empty;
        }

        var table = ActiveTable;
        if (!table.TryGetValue(key, out var value) && !Table.TryGetValue(key, out value))
        {
            value = key;
        }

        return args is { Length: > 0 }
            ? string.Format(CultureInfo.InvariantCulture, value, args)
            : value;
    }

    /// <summary>Resolves a language tag to a supported culture; unknown tags map to English.</summary>
    public static CultureInfo Normalize(string? language)
    {
        if (string.IsNullOrWhiteSpace(language))
        {
            return new CultureInfo(EnglishLanguage);
        }

        var tag = language.Trim().Replace('_', '-');
        if (tag.Equals("zh", StringComparison.OrdinalIgnoreCase) ||
            tag.StartsWith("zh-", StringComparison.OrdinalIgnoreCase))
        {
            return new CultureInfo(ChineseLanguage);
        }

        return new CultureInfo(EnglishLanguage);
    }

    private static Dictionary<string, string> ActiveTable =>
        _culture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase)
            ? StringsZhCn.Table
            : Table;

    private static CultureInfo ResolveDefaultCulture() =>
        Normalize(Environment.GetEnvironmentVariable("VECTANIM_LANG"));
}
