require 'rubygems'
require 'sinatra'
require 'haml'
require 'aws/s3'
require 'base64'

get '/' do
  @images = Dir.entries(File.join('public', 'images')).select {|i| i =~ /\.png/}.sort {|a, b| b <=> a}
  
  comb1 = ['00', 'ff', 'ff'].permutation(3).to_a.uniq
  comb2 = ['00', '00', 'ff'].permutation(3).to_a.uniq
  combinations = comb1 + comb2 << ['000000'] << ['ffffff']
  @colors = combinations.map {|e| "##{e.join}"}
  
  haml :index
end

post '/upload' do
  image = "#{Time.now.to_i}.png"
  
  begin
    File.open(File.join('public', 'images', image), "w") do |file|
      file << Base64.decode64(params[:imageData].gsub(/data:image\/png;base64/, ''))
    end
  rescue => e
    "failure: #{e}"
  end
  
  image
end