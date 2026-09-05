using System.Diagnostics;

namespace E2ugh;

/// <summary>
/// Builds and starts explicit local e2ugh virtual-hardware-engine CLI process
/// invocations. The adapter never invokes a shell, never stores credentials
/// and never touches host hardware: it only assembles argument vectors for a
/// user-owned local <c>e2ugh</c> binary (installed through
/// <c>npm i -g @wenathlan/e2ugh</c> or extracted from the
/// <c>ghcr.io/wenathlan/e2ugh</c> container).
/// </summary>
public static class E2ughCli
{
    /// <summary>Returns a process start configuration without involving a shell.</summary>
    public static ProcessStartInfo StartInfo(params string[] arguments)
    {
        var executable = Environment.GetEnvironmentVariable("E2UGH_BIN") ?? "e2ugh";
        var startInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return startInfo;
    }

    /// <summary>Starts a user-owned local e2ugh binary with the supplied arguments.</summary>
    public static Process Start(params string[] arguments)
    {
        return Process.Start(StartInfo(arguments)) ?? throw new InvalidOperationException("e2ugh could not be started.");
    }
}
