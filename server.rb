require 'rubygems'
require 'sinatra'
require 'haml'
require 'aws/s3'
require 'base64'

S3_BUCKET = 'draw.heroku.com'

helpers do
  def is_production?
    ENV['RACK_ENV'] == 'production'
  end
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

    @drawings = AWS::S3::Bucket.objects(S3_BUCKET).sort {|a, b| b.about['date'] <=> a.about['date']}
  else
    @drawings = Dir.entries(File.join('public', 'images', 'drawings')).select {|i| i =~ /\.png/}.sort {|a, b| b <=> a}
  end
  
  comb1 = ['00', 'ff', 'ff'].permutation(3).to_a.uniq
  comb2 = ['00', '00', 'ff'].permutation(3).to_a.uniq
  combinations = comb1 + comb2 << ['000000'] << ['ffffff']
  @colors = combinations.map {|e| "##{e.join}"}
  
  haml :index
end

get '/drawings/:id' do
  if is_production?
    init_aws
    
    @drawing = AWS::S3::S3Object.find(params[:id], S3_BUCKET)
  else
    @drawing = params[:id]
  end
  
  if @drawing.nil?
    haml :not_found
  else
    haml :drawing
  end
end

post '/upload' do
  drawing = "#{Time.now.to_i}.png"
  
  begin
    if is_production?
      init_aws

      AWS::S3::S3Object.store(
        drawing,
        Base64.decode64(params[:imageData].gsub(/data:image\/png;base64/, '')),
        S3_BUCKET)
    else
      File.open(File.join('public', 'images', 'drawings', drawing), "w") do |file|
        file << Base64.decode64(params[:imageData].gsub(/data:image\/png;base64/, ''))
      end
    end
  rescue => e
    "failure: #{e}"
  end
  
  haml :thumb, :layout => false, :locals => {:id => drawing, :drawing_url => is_production? ? "http://#{S3_BUCKET}.s3.amazonaws.com/#{drawing}" : "/images/drawings/#{drawing}", :share_url => "http://draw.heroku.com/drawings/#{drawing}"}
end