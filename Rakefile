require 'rubygems'
require 'rake'
require 'rspec/core/rake_task'
require 'net/http'

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

desc "Compile javascript files"
task :compile do
  ['pixel.js', 'init.js'].each do |file|
    library_path = "public/javascripts/#{file}"
    output_path = "#{library_path.gsub(/\.js$/, '')}.min.js"
    
    puts "Compiling #{library_path}"
    uri = URI('http://closure-compiler.appspot.com/compile')
    options = {
      'js_code'           => File.open(library_path).read,
      'compilation_level' => 'SIMPLE_OPTIMIZATIONS',
      'output_format'     => 'text',
      'output_info'       => 'compiled_code'
    }
    res = Net::HTTP.post_form(uri, options)
    
    puts "Writing compiled code to #{output_path}"
    File.open(output_path, 'w') {|f| f.write(res.body)}
  end
end