require 'rubygems'
require 'sinatra'
require 'haml'
require 'aws/s3'
require 'base64'

def is_production?
  ENV['RACK_ENV'] == 'production'
end

def init_aws
  AWS::S3::Base.establish_connection!(
    :access_key_id     => ENV['S3_KEY'],
    :secret_access_key => ENV['S3_SECRET']
  )
end

get '/' do
  if is_production?
    init_aws

    @images = AWS::S3::Bucket.objects('draw.heroku.com')
  else
    @images = Dir.entries(File.join('public', 'images')).select {|i| i =~ /\.png/}.sort {|a, b| b <=> a}
  end
  
  comb1 = ['00', 'ff', 'ff'].permutation(3).to_a.uniq
  comb2 = ['00', '00', 'ff'].permutation(3).to_a.uniq
  combinations = comb1 + comb2 << ['000000'] << ['ffffff']
  @colors = combinations.map {|e| "##{e.join}"}
  
  haml :index
end

post '/upload' do
  image = "#{Time.now.to_i}.png"
  
  begin
    if is_production?
      init_aws

      AWS::S3::S3Object.store(
        image,
        Base64.decode64(params[:imageData].gsub(/data:image\/png;base64/, '')),
        "draw.heroku.com"
      )
    else
      File.open(File.join('public', 'images', image), "w") do |file|
        file << Base64.decode64(params[:imageData].gsub(/data:image\/png;base64/, ''))
      end
    end
  rescue => e
    "failure: #{e}"
  end
  
  image
end