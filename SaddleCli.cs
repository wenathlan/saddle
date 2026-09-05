using System.Diagnostics;

namespace Saddle;

/// <summary>
/// Builds and starts explicit local saddle virtual-hardware-engine CLI process
/// invocations. The adapter never invokes a shell, never stores credentials
/// and never touches host hardware: it only assembles argument vectors for a
/// user-owned local <c>saddle</c> binary (installed through
/// <c>npm i -g @wenathlan/saddle</c> or extracted from the
/// <c>ghcr.io/wenathlan/saddle</c> container).
/// </summary>
/// <remarks>
/// Grand-merge lineage: the class adapts the e2ugh virtual-hardware engine
/// CLI surface that joined saddle at 2.0.0; the binary resolves every engine
/// command (the plan renderer, the mode catalog, the mcp surface and the
/// engine example) through the single saddle bin.
/// </remarks>
public static class SaddleCli
{
    /// <summary>Returns a process start configuration without involving a shell.</summary>
    public static ProcessStartInfo StartInfo(params string[] arguments)
    {
        var executable = Environment.GetEnvironmentVariable("SADDLE_BIN") ?? "saddle";
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

    /// <summary>Starts a user-owned local saddle binary with the supplied arguments.</summary>
    public static Process Start(params string[] arguments)
    {
        return Process.Start(StartInfo(arguments)) ?? throw new InvalidOperationException("saddle could not be started.");
    }
}
