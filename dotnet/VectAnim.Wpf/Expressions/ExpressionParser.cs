using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Expressions;

/// <summary>Expression evaluation context.</summary>
public interface IExpressionContext
{
    /// <summary>Animation time (seconds).</summary>
    double Time { get; }

    /// <summary>Reads a variable; returns false when it does not exist.</summary>
    bool TryGetVariable(string name, out double value);
}

internal abstract class ExpressionNode
{
}

internal sealed class NumberNode : ExpressionNode
{
    public NumberNode(double value) => Value = value;

    public double Value { get; }
}

internal sealed class VariableNode : ExpressionNode
{
    public VariableNode(string name) => Name = name;

    public string Name { get; }
}

internal sealed class UnaryNode : ExpressionNode
{
    public UnaryNode(string op, ExpressionNode operand)
    {
        Operator = op;
        Operand = operand;
    }

    public string Operator { get; }

    public ExpressionNode Operand { get; }
}

internal sealed class BinaryNode : ExpressionNode
{
    public BinaryNode(string op, ExpressionNode left, ExpressionNode right)
    {
        Operator = op;
        Left = left;
        Right = right;
    }

    public string Operator { get; }

    public ExpressionNode Left { get; }

    public ExpressionNode Right { get; }
}

internal sealed class ConditionalNode : ExpressionNode
{
    public ConditionalNode(ExpressionNode condition, ExpressionNode whenTrue, ExpressionNode whenFalse)
    {
        Condition = condition;
        WhenTrue = whenTrue;
        WhenFalse = whenFalse;
    }

    public ExpressionNode Condition { get; }

    public ExpressionNode WhenTrue { get; }

    public ExpressionNode WhenFalse { get; }
}

internal sealed class CallNode : ExpressionNode
{
    public CallNode(string name, IReadOnlyList<ExpressionNode> arguments)
    {
        Name = name;
        Arguments = arguments;
    }

    public string Name { get; }

    public IReadOnlyList<ExpressionNode> Arguments { get; }
}

/// <summary>
/// Recursive-descent parser (precedence identical to the TypeScript side):
/// ?: → || → &amp;&amp; → == != → &lt; &lt;= &gt; &gt;= → + - → * / % → unary + - ! → ^ → primary
/// </summary>
internal sealed class ExpressionParser
{
    private readonly List<ExpressionToken> _tokens;
    private int _index;

    private ExpressionParser(List<ExpressionToken> tokens) => _tokens = tokens;

    public static ExpressionNode Parse(string source)
    {
        var tokens = ExpressionLexer.Tokenize(source);
        if (tokens.Count == 1)
        {
            throw new ExpressionException(Strings.T("Expression.Empty"), 0);
        }

        var parser = new ExpressionParser(tokens);
        var node = parser.ParseConditional();
        var tail = parser.Current;
        if (tail.Kind != TokenKind.End)
        {
            throw new ExpressionException(Strings.T("Expression.TrailingContent", tail.Text), tail.Position);
        }

        return node;
    }

    private ExpressionToken Current => _tokens[_index];

    private ExpressionToken Advance() => _tokens[_index++];

    private bool MatchOperator(params string[] operators)
    {
        var token = Current;
        if (token.Kind == TokenKind.Operator && Array.IndexOf(operators, token.Text) >= 0)
        {
            _index++;
            return true;
        }

        return false;
    }

    private string ConsumeOperator()
    {
        return _tokens[_index - 1].Text;
    }

    private void ExpectOperator(string text)
    {
        if (!MatchOperator(text))
        {
            var token = Current;
            throw new ExpressionException(
                Strings.T(
                    "Expression.MissingOperator",
                    text,
                    token.Kind == TokenKind.End ? Strings.T("Expression.TokenEnd") : token.Text),
                token.Position);
        }
    }

    private ExpressionNode ParseConditional()
    {
        var condition = ParseLogicalOr();
        if (MatchOperator("?"))
        {
            var whenTrue = ParseConditional();
            ExpectOperator(":");
            var whenFalse = ParseConditional();
            return new ConditionalNode(condition, whenTrue, whenFalse);
        }

        return condition;
    }

    private ExpressionNode ParseLogicalOr()
    {
        var left = ParseLogicalAnd();
        while (MatchOperator("||"))
        {
            left = new BinaryNode("||", left, ParseLogicalAnd());
        }

        return left;
    }

    private ExpressionNode ParseLogicalAnd()
    {
        var left = ParseEquality();
        while (MatchOperator("&&"))
        {
            left = new BinaryNode("&&", left, ParseEquality());
        }

        return left;
    }

    private ExpressionNode ParseEquality()
    {
        var left = ParseComparison();
        while (MatchOperator("==", "!="))
        {
            left = new BinaryNode(ConsumeOperator(), left, ParseComparison());
        }

        return left;
    }

    private ExpressionNode ParseComparison()
    {
        var left = ParseAdditive();
        while (MatchOperator("<", "<=", ">", ">="))
        {
            left = new BinaryNode(ConsumeOperator(), left, ParseAdditive());
        }

        return left;
    }

    private ExpressionNode ParseAdditive()
    {
        var left = ParseMultiplicative();
        while (MatchOperator("+", "-"))
        {
            left = new BinaryNode(ConsumeOperator(), left, ParseMultiplicative());
        }

        return left;
    }

    private ExpressionNode ParseMultiplicative()
    {
        var left = ParseUnary();
        while (MatchOperator("*", "/", "%"))
        {
            left = new BinaryNode(ConsumeOperator(), left, ParseUnary());
        }

        return left;
    }

    private ExpressionNode ParseUnary()
    {
        if (MatchOperator("-", "+", "!"))
        {
            var op = ConsumeOperator();
            return new UnaryNode(op, ParseUnary());
        }

        return ParsePower();
    }

    private ExpressionNode ParsePower()
    {
        var baseNode = ParsePrimary();
        if (MatchOperator("^"))
        {
            // Right-associative: 2^3^2 = 2^(3^2)
            return new BinaryNode("^", baseNode, ParseUnary());
        }

        return baseNode;
    }

    private ExpressionNode ParsePrimary()
    {
        var token = Advance();

        switch (token.Kind)
        {
            case TokenKind.Number:
                return new NumberNode(token.Value);

            case TokenKind.LeftParen:
            {
                var inner = ParseConditional();
                if (Advance().Kind != TokenKind.RightParen)
                {
                    throw new ExpressionException(Strings.T("Expression.MissingClosingParen"), token.Position);
                }

                return inner;
            }

            case TokenKind.Identifier:
            {
                var lowered = token.Text.ToLowerInvariant();
                var isCall = Current.Kind == TokenKind.LeftParen;

                if (isCall)
                {
                    var spec = ExpressionFunctions.Find(lowered)
                        ?? throw new ExpressionException(Strings.T("Expression.UnsupportedFunction", token.Text), token.Position);

                    Advance(); // consume '('
                    var arguments = new List<ExpressionNode>();
                    if (Current.Kind != TokenKind.RightParen)
                    {
                        arguments.Add(ParseConditional());
                        while (Current.Kind == TokenKind.Comma)
                        {
                            Advance();
                            arguments.Add(ParseConditional());
                        }
                    }

                    if (Advance().Kind != TokenKind.RightParen)
                    {
                        throw new ExpressionException(Strings.T("Expression.FunctionMissingClosingParen", token.Text), token.Position);
                    }

                    if (arguments.Count < spec.MinArgs || arguments.Count > spec.MaxArgs)
                    {
                        var expected = spec.MinArgs == spec.MaxArgs
                            ? spec.MinArgs.ToString()
                            : $"{spec.MinArgs}..{spec.MaxArgs}";
                        throw new ExpressionException(
                            Strings.T("Expression.FunctionArgCount", token.Text, expected, arguments.Count),
                            token.Position);
                    }

                    return new CallNode(lowered, arguments);
                }

                if (ExpressionFunctions.TryGetConstant(lowered, out var constant))
                {
                    return new NumberNode(constant);
                }

                return new VariableNode(token.Text);
            }

            default:
                throw new ExpressionException(
                    Strings.T(
                        "Expression.UnexpectedToken",
                        token.Kind == TokenKind.End ? Strings.T("Expression.TokenEnd") : token.Text),
                    token.Position);
        }
    }
}
