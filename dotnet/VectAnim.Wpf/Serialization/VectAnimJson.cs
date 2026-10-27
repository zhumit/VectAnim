using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using VectAnim.Wpf.Localization;
using VectAnim.Wpf.Model;

namespace VectAnim.Wpf.Serialization;

/// <summary>
/// Read/write entry point for .vectanim.json.
///
/// Read strategy: tolerate first - case-insensitive, comments and trailing commas allowed, unknown fields ignored,
/// unknown enum values fall back to their defaults. Shop-floor files are edited by hand, so one typo must not fail the whole load.
/// </summary>
public static class VectAnimJson
{
    /// <summary>Serializer options (shared by read and write).</summary>
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.AllowNamedFloatingPointLiterals,
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        options.Converters.Add(new ValueRefJsonConverter());
        return options;
    }

    /// <summary>Loads from a file.</summary>
    public static VectAnimDocument LoadFromFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException(Strings.T("Json.PathEmpty"), nameof(path));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException(Strings.T("Json.FileNotFound", path), path);
        }

        return LoadFromString(File.ReadAllText(path));
    }

    /// <summary>Loads from JSON text.</summary>
    public static VectAnimDocument LoadFromString(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            throw new InvalidDataException(Strings.T("Json.ContentEmpty"));
        }

        var document = JsonSerializer.Deserialize<VectAnimDocument>(json, Options);
        if (document is null)
        {
            throw new InvalidDataException(Strings.T("Json.ContentNotObject"));
        }

        DocumentValidator.Normalize(document);
        return document;
    }

    /// <summary>Tries to load from text without throwing.</summary>
    public static bool TryLoadFromString(string json, out VectAnimDocument? document, out string? error)
    {
        try
        {
            document = LoadFromString(json);
            error = null;
            return true;
        }
        catch (Exception exception)
        {
            document = null;
            error = exception.Message;
            return false;
        }
    }

    /// <summary>Tries to load from a file without throwing.</summary>
    public static bool TryLoadFromFile(string path, out VectAnimDocument? document, out string? error)
    {
        try
        {
            document = LoadFromFile(path);
            error = null;
            return true;
        }
        catch (Exception exception)
        {
            document = null;
            error = exception.Message;
            return false;
        }
    }

    /// <summary>Serializes to JSON text.</summary>
    public static string Save(VectAnimDocument document, bool indented = true)
    {
        var options = indented ? Options : new JsonSerializerOptions(Options) { WriteIndented = false };
        return JsonSerializer.Serialize(document, options);
    }

    /// <summary>Saves to a file (UTF-8, no BOM).</summary>
    public static void SaveToFile(VectAnimDocument document, string path)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(path, Save(document), new System.Text.UTF8Encoding(false));
    }
}
