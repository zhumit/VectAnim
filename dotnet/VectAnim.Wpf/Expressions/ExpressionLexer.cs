using System.Globalization;
using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Expressions;

/// <summary>Expression syntax or semantic error.</summary>
public sealed class ExpressionException : Exception
{
    /// <summary>Creates the exception.</summary>
    public ExpressionException(string message, int position = 0)
        : base(message)
    {
        Position = position;
    }

    /// <summary>Error position (character offset).</summary>
    public int Position { get; }
}

internal enum TokenKind
{
    Number,
    Identifier,
    Operator,
    LeftParen,
    RightParen,
    Comma,
    End,
}

internal readonly struct ExpressionToken
{
    public ExpressionToken(TokenKind kind, string text, int position, double value = 0)
    {
        Kind = kind;
        Text = text;
        Position = position;
        Value = value;
    }

    public TokenKind Kind { get; }

    public string Text { get; }

    public int Position { get; }

    public double Value { get; }
}

/// <summary>
/// Expression tokenizer. Kept in sync with tokenize on the TypeScript side:
/// Numbers accept a decimal point and scientific notation; identifiers may start with a letter, underscore or dollar sign and may contain embedded dots.
/// </summary>
internal static class ExpressionLexer
{
    private static readonly string[] TwoCharOperators = { "<=", ">=", "==", "!=", "&&", "||" };
    private static readonly char[] OneCharOperators = { '+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':' };

    public static List<ExpressionToken> Tokenize(string source)
    {
        var tokens = new List<ExpressionToken>();
        var index = 0;

        while (index < source.Length)
        {
            var current = source[index];

            if (char.IsWhiteSpace(current))
            {
                index++;
                continue;
            }

            if (char.IsDigit(current) || (current == '.' && index + 1 < source.Length && char.IsDigit(source[index + 1])))
            {
                var start = index;
                while (index < source.Length && (char.IsDigit(source[index]) || source[index] == '.'))
                {
                    index++;
                }

                if (index < source.Length && (source[index] == 'e' || source[index] == 'E'))
                {
                    var mark = index;
                    index++;
                    if (index < source.Length && (source[index] == '+' || source[index] == '-'))
                    {
                        index++;
                    }

                    if (index < source.Length && char.IsDigit(source[index]))
                    {
                        while (index < source.Length && char.IsDigit(source[index]))
                        {
                            index++;
                        }
                    }
                    else
                    {
                        index = mark;
                    }
                }

                var text = source.Substring(start, index - start);
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ||
                    double.IsNaN(value) || double.IsInfinity(value))
                {
                    throw new ExpressionException(Strings.T("Expression.InvalidNumber", text), start);
                }

                tokens.Add(new ExpressionToken(TokenKind.Number, text, start, value));
                continue;
            }

            if (IsIdentifierStart(current))
            {
                var start = index;
                while (index < source.Length && IsIdentifierPart(source[index]))
                {
                    index++;
                }

                tokens.Add(new ExpressionToken(TokenKind.Identifier, source.Substring(start, index - start), start));
                continue;
            }

            if (current == '(')
            {
                tokens.Add(new ExpressionToken(TokenKind.LeftParen, "(", index++));
                continue;
            }

            if (current == ')')
            {
                tokens.Add(new ExpressionToken(TokenKind.RightParen, ")", index++));
                continue;
            }

            if (current == ',')
            {
                tokens.Add(new ExpressionToken(TokenKind.Comma, ",", index++));
                continue;
            }

            if (index + 1 < source.Length)
            {
                var pair = source.Substring(index, 2);
                if (Array.IndexOf(TwoCharOperators, pair) >= 0)
                {
                    tokens.Add(new ExpressionToken(TokenKind.Operator, pair, index));
                    index += 2;
                    continue;
                }
            }

            if (Array.IndexOf(OneCharOperators, current) >= 0)
            {
                tokens.Add(new ExpressionToken(TokenKind.Operator, current.ToString(), index++));
                continue;
            }

            throw new ExpressionException(Strings.T("Expression.UnrecognizedCharacter", current), index);
        }

        tokens.Add(new ExpressionToken(TokenKind.End, string.Empty, source.Length));
        return tokens;
    }

    private static bool IsIdentifierStart(char value) =>
        (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || value == '_' || value == '$';

    private static bool IsIdentifierPart(char value) => IsIdentifierStart(value) || char.IsDigit(value) || value == '.';
}
