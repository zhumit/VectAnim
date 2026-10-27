using System.Windows.Markup;

namespace VectAnim.Wpf.Localization;

/// <summary>
/// XAML markup extension that resolves a key through <see cref="Strings"/>:
/// <code>&lt;TextBlock Text="{loc:Loc Key=Demo.OpenFile}" /&gt;</code>
/// with <c>xmlns:loc="clr-namespace:VectAnim.Wpf.Localization;assembly=VectAnim.Wpf"</c>.
///
/// The value is resolved once, when the XAML is loaded. Call <see cref="Strings.Culture"/>
/// before creating the window to pick a language.
/// </summary>
[MarkupExtensionReturnType(typeof(string))]
public sealed class LocExtension : MarkupExtension
{
    /// <summary>Creates an empty extension (used by the XAML parser with a named Key).</summary>
    public LocExtension()
    {
    }

    /// <summary>Creates an extension for the given key.</summary>
    public LocExtension(string key) => Key = key;

    /// <summary>Resource key, for example <c>Demo.OpenFile</c>.</summary>
    [ConstructorArgument("key")]
    public string? Key { get; set; }

    /// <inheritdoc />
    public override object ProvideValue(IServiceProvider serviceProvider) =>
        string.IsNullOrEmpty(Key) ? string.Empty : Strings.T(Key!);
}
