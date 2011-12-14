require 'rubygems'
require 'rake'
require 'rspec/core/rake_task'

desc "Default: run specs"
task :default => :spec

desc "Run specs"
RSpec::Core::RakeTask.new

desc "Start server (shortcut: s)"
task :server do
  ruby 'server.rb'
end
task :s => :server

desc "Start console (shortcut: c)"
task :console do
  sh 'irb', '-r', 'server.rb'
end
task :c => :console

desc "Draw! statistics"
task :stats do
  def resource_count(resource_name)
    %x[heroku console 'REDIS.keys("#{resource_name}:*").size']
  end
  
  puts "Drawings: #{resource_count('drawing')}"
  puts "Users: #{resource_count('user')}"
end