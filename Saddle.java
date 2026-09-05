package io.wenathlan.saddle;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Builds and starts explicit local saddle virtual-hardware-engine CLI process
 * invocations. The adapter never invokes a shell, never stores credentials
 * and never touches host hardware: it only assembles argument vectors for a
 * user-owned local {@code saddle} binary (installed through
 * {@code npm i -g @wenathlan/saddle} or extracted from the
 * {@code ghcr.io/wenathlan/saddle} container).
 *
 * <p>Grand-merge lineage: the class adapts the e2ugh virtual-hardware engine
 * CLI surface that joined saddle at 2.0.0; the binary resolves every engine
 * command (the plan renderer, the mode catalog, the mcp surface and the
 * engine example) through the single saddle bin.</p>
 */
public final class Saddle {
  private Saddle() {
  }

  /** Returns the executable command and supplied arguments without invoking a shell. */
  public static List<String> command(String... arguments) {
    var command = new ArrayList<String>();
    command.add(System.getenv().getOrDefault("SADDLE_BIN", "saddle"));
    command.addAll(Arrays.asList(arguments));
    return List.copyOf(command);
  }

  /** Creates a process builder for a user-owned local saddle binary. */
  public static ProcessBuilder process(String... arguments) {
    return new ProcessBuilder(command(arguments));
  }

  /** Starts a user-owned local saddle binary with the supplied arguments. */
  public static Process start(String... arguments) throws IOException {
    return process(arguments).start();
  }
}
