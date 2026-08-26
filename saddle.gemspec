Gem::Specification.new do |spec|
  spec.name = "saddle"
  spec.version = ENV.fetch("SADDLE_VERSION", "1.8.19")
  spec.authors = ["wenathlan"]
  spec.summary = "Binary computing engine for distributed storage"
  spec.description = "Binary computing engine that turns distributed storage into a publishable working set."
  spec.homepage = "https://github.com/wenathlan/saddle"
  spec.license = "GPL-3.0-only"
  spec.required_ruby_version = ">= 3.1"
  spec.files = %w[LICENSE README.md changelog.md]
  spec.metadata = {
    "source_code_uri" => "https://github.com/wenathlan/saddle",
    "bug_tracker_uri" => "https://github.com/wenathlan/saddle/issues",
    "github_repo" => "ssh://github.com/wenathlan/saddle"
  }
end
