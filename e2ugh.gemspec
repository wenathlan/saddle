Gem::Specification.new do |spec|
  spec.name = "e2ugh"
  spec.version = ENV.fetch("E2UGH_VERSION", "2.0.0")
  spec.authors = ["wenathlan"]
  spec.email = ["support@users.noreply.github.com"]
  spec.summary = "Ruby process adapter for the e2ugh virtual hardware engine CLI."
  spec.description = "Builds explicit local e2ugh CLI invocations without storing credentials or touching host hardware."
  spec.homepage = "https://github.com/wenathlan/saddle"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"
  spec.files = ["readme.md", "runner/e2ugh.rb"]
  spec.require_paths = ["runner"]
  spec.metadata["source_code_uri"] = "https://github.com/wenathlan/saddle"
  spec.metadata["homepage_uri"] = spec.homepage
end
