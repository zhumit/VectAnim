using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Tests
{
    /// <summary>Checks that the two string tables stay in sync and that lookups fall back predictably.</summary>
    internal static class LocalizationTests
    {
        public static void Register(TestRunner runner)
        {
            const string suite = "Localization";

            runner.Add(suite, "Every English key has a Chinese translation", () =>
            {
                var missing = Strings.MissingKeys;
                Check.True(missing.Count == 0, $"Missing zh-CN translations: {string.Join(", ", missing)}");
            });

            runner.Add(suite, "No table holds an empty value", () =>
            {
                var culture = Strings.Culture;
                try
                {
                    foreach (var tag in new[] { "en", "zh-CN" })
                    {
                        Strings.Culture = Strings.Normalize(tag);
                        foreach (var key in Strings.Keys)
                        {
                            Check.False(
                                string.IsNullOrWhiteSpace(Strings.T(key)),
                                $"Empty translation for '{key}' in {tag}");
                        }
                    }
                }
                finally
                {
                    Strings.Culture = culture;
                }
            });

            runner.Add(suite, "Unknown keys fall back to the key itself", () =>
            {
                Check.Equal("does.not.exist", Strings.T("does.not.exist"), "Missing key fallback");
                Check.Equal(string.Empty, Strings.T(string.Empty), "Empty key");
            });

            runner.Add(suite, "Language tags are normalised", () =>
            {
                Check.Equal("zh-CN", Strings.Normalize("zh").Name, "zh maps to zh-CN");
                Check.Equal("zh-CN", Strings.Normalize("zh_CN").Name, "zh_CN maps to zh-CN");
                Check.Equal("en", Strings.Normalize("fr-FR").Name, "Unsupported tags fall back to English");
                Check.Equal("en", Strings.Normalize(null).Name, "Null falls back to English");
            });

            runner.Add(suite, "Switching the culture switches the text", () =>
            {
                var culture = Strings.Culture;
                try
                {
                    Strings.Culture = Strings.Normalize("en");
                    var english = Strings.T("Demo.ShapeCountFormat", 3);
                    Strings.Culture = Strings.Normalize("zh-CN");
                    var chinese = Strings.T("Demo.ShapeCountFormat", 3);

                    Check.True(english.Contains('3'), $"English text should contain the argument: {english}");
                    Check.True(chinese.Contains('3'), $"Chinese text should contain the argument: {chinese}");
                    Check.True(english != chinese, "The two cultures should not return the same text");
                }
                finally
                {
                    Strings.Culture = culture;
                }
            });
        }
    }
}
