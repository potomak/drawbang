require 'rubygems'
require 'rake'
require 'rspec/core/rake_task'

desc "Default: run specs"
task :default => :spec

desc "Run specs"
RSpec::Core::RakeTask.new

desc "Start server"
task :s do
  ruby 'server.rb'
end

desc "Start console"
task :c do
  sh 'irb -r server.rb'
end