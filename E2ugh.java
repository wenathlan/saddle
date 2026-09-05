package io.github.wenathlan.e2ugh;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Builds and starts explicit local e2ugh virtual-hardware-engine CLI process
 * invocations. The adapter never invokes a shell, never stores credentials
 * and never touches host hardware: it only assembles argument vectors for a
 * user-owned local {@code e2ugh} binary (installed through
 * {@code npm i -g @wenathlan/e2ugh} or extracted from the
 * {@code ghcr.io/wenathlan/e2ugh} container).
 */
public final class E2ugh {
  private E2ugh() {
  }

  /** Returns the executable command and supplied arguments without invoking a shell. */
  public static List<String> command(String... arguments) {
    var command = new ArrayList<String>();
    command.add(System.getenv().getOrDefault("E2UGH_BIN", "e2ugh"));
    command.addAll(Arrays.asList(arguments));
    return List.copyOf(command);
  }

  /** Creates a process builder for a user-owned local e2ugh binary. */
  public static ProcessBuilder process(String... arguments) {
    return new ProcessBuilder(command(arguments));
  }

  /** Starts a user-owned local e2ugh binary with the supplied arguments. */
  public static Process start(String... arguments) throws IOException {
    return process(arguments).start();
  }
}
