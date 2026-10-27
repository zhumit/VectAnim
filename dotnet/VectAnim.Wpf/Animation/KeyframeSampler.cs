using VectAnim.Wpf.Model;

namespace VectAnim.Wpf.Animation;

/// <summary>
/// Keyframe sampling (aligned line by line with the TypeScript editor implementation).
///
/// Rules:
///  - Keyframes are ordered by ascending time; at the same time point the last one wins;
///  - Before the first frame the first value is used, after the last frame the last value;
///  - Loop period = last frame time + LoopDelay; inside the delay window the last value is held;
///  - Easing is taken from the starting keyframe and applies to the next keyframe.
/// </summary>
public static class KeyframeSampler
{
    /// <summary>Sorts by time and drops duplicates (the later one wins).</summary>
    public static List<Keyframe> Sort(IEnumerable<Keyframe> keyframes)
    {
        var sorted = keyframes.OrderBy(frame => frame.Time).ToList();
        var result = new List<Keyframe>(sorted.Count);
        foreach (var frame in sorted)
        {
            if (result.Count > 0 && Math.Abs(result[^1].Time - frame.Time) < 1e-9)
            {
                result[^1] = frame;
            }
            else
            {
                result.Add(frame);
            }
        }

        return result;
    }

    /// <summary>Animation duration (the time of the last keyframe).</summary>
    public static double Duration(IReadOnlyList<Keyframe> keyframes)
    {
        var max = 0d;
        foreach (var frame in keyframes)
        {
            if (frame.Time > max)
            {
                max = frame.Time;
            }
        }

        return max;
    }

    /// <summary>Applies easing.</summary>
    public static double ApplyEasing(EasingKind kind, double t)
    {
        var value = t < 0 ? 0 : t > 1 ? 1 : t;
        return kind switch
        {
            EasingKind.Step => 0,
            EasingKind.EaseIn => value * value,
            EasingKind.EaseOut => 1 - ((1 - value) * (1 - value)),
            EasingKind.EaseInOut => value < 0.5
                ? 2 * value * value
                : 1 - (2 * (1 - value) * (1 - value)),
            _ => value,
        };
    }

    /// <summary>Samples the keyframes; returns null for an empty collection.</summary>
    public static double? Sample(IReadOnlyList<Keyframe> keyframes, double time, bool loop, double loopDelay)
    {
        var frames = Sort(keyframes);
        if (frames.Count == 0)
        {
            return null;
        }

        if (frames.Count == 1)
        {
            return frames[0].Value;
        }

        var duration = Duration(frames);
        var delay = loopDelay > 0 ? loopDelay : 0;
        var local = time;

        if (loop)
        {
            var period = duration + delay;
            if (period <= 0)
            {
                return frames[^1].Value;
            }

            local = time % period;
            if (local < 0)
            {
                local += period;
            }

            if (local > duration)
            {
                return frames[^1].Value;
            }
        }
        else if (local <= 0)
        {
            return frames[0].Value;
        }
        else if (local >= duration)
        {
            return frames[^1].Value;
        }

        var low = 0;
        var high = frames.Count - 1;
        while (low < high - 1)
        {
            var middle = (low + high) >> 1;
            if (frames[middle].Time <= local)
            {
                low = middle;
            }
            else
            {
                high = middle;
            }
        }

        var start = frames[low];
        var end = frames[high];
        var span = end.Time - start.Time;
        if (span <= 1e-9)
        {
            return end.Value;
        }

        var ratio = (local - start.Time) / span;
        var eased = ApplyEasing(start.Easing ?? EasingKind.Linear, ratio);
        return start.Value + ((end.Value - start.Value) * eased);
    }

    /// <summary>Computes the longest duration among a set of animations.</summary>
    public static double LongestDuration(IEnumerable<KeyframeAnimationDefinition> animations)
    {
        var max = 0d;
        foreach (var animation in animations)
        {
            if (animation.Enabled == false)
            {
                continue;
            }

            var duration = Duration(animation.Keyframes);
            if (duration > max)
            {
                max = duration;
            }
        }

        return max;
    }
}
