# frozen_string_literal: true

# SaddleCli.rb — the Ruby process adapter of the saddle virtual-hardware
# engine CLI (the grand-merge readaptation of the former e2ugh runner
# concept: the e2ugh gem carrier declared runner/e2ugh.rb, a file that
# never existed in either repository; the merged saddle carrier ships the
# adapter it declares, completing the feature).
#
# The adapter never invokes a shell, never stores credentials and never
# touches host hardware: it only assembles argument vectors for a
# user-owned local `saddle` binary (installed through
# `npm i -g @wenathlan/saddle` or extracted from the
# `ghcr.io/wenathlan/saddle` container).
module SaddleCli
  # Resolves the user-owned local saddle binary (SADDLE_BIN wins over PATH).
  # @return [String] the executable name
  def self.executable
    ENV.fetch("SADDLE_BIN", "saddle")
  end

  # Returns the executable command and supplied arguments without a shell.
  # @param arguments [Array<String>] the CLI arguments
  # @return [Array<String>] the full argument vector
  def self.command(*arguments)
    [executable, *arguments].freeze
  end

  # Starts a user-owned local saddle binary with the supplied arguments.
  # @param arguments [Array<String>] the CLI arguments
  # @return [Process::Status] the wait result of the invocation
  def self.run(*arguments)
    system(*command(*arguments), exception: true)
  end
end
