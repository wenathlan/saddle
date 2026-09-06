# frozen_string_literal: true

# saddle.gemspec — the merged Ruby carrier of the saddle repository.
#
# Grand-merge lineage: the former e2ugh gem carrier (the "process adapter for
# the virtual-hardware engine CLI") and the former saddle gem carrier (the
# library envelope) merge into this single specification at 2.0.0: every
# metadata field of both lineages is readapted to the saddle product, the
# Ruby process adapter (SaddleCli.rb — the former runner concept) ships
# inside the gem, and the files list carries the real repository envelopes
# (the former e2ugh carrier referenced a runner path that never existed;
# the merged spec fixes that by shipping the adapter it declares).
Gem::Specification.new do |spec|
  spec.name = "saddle"
  spec.version = ENV.fetch("SADDLE_VERSION", "2.0.6")
  spec.authors = ["wenathlan"]
  spec.email = ["support@users.noreply.github.com"]
  spec.summary = "Binary computing engine for distributed storage with the merged virtual-hardware engine CLI adapter"
  spec.description = "Binary computing engine that turns distributed storage into a publishable working set, carrying the merged virtual-hardware engine CLI process adapter (explicit local invocations, no shell, no credentials, no host hardware)."
  spec.homepage = "https://github.com/wenathlan/saddle"
  spec.license = "GPL-3.0-only"
  spec.required_ruby_version = ">= 3.1"
  spec.files = %w[LICENSE README.md CHANGELOG.md SaddleCli.rb]
  spec.require_paths = ["."]
  spec.metadata = {
    "source_code_uri" => "https://github.com/wenathlan/saddle",
    "bug_tracker_uri" => "https://github.com/wenathlan/saddle/issues",
    "github_repo" => "ssh://github.com/wenathlan/saddle"
  }
end
