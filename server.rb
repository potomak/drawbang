require 'rubygems'
require 'sinatra'
require 'haml'
require 'aws/s3'
require 'omniauth/oauth'
require 'base64'
require 'yaml'
require 'redis'
require 'system_timer'
require 'json'
require 'rack-flash'

configure do
  require 'config/config'
  require "config/#{settings.environment}"
  
  enable :sessions
end

use OmniAuth::Builder do
  provider :facebook, FACEBOOK['app_id'], FACEBOOK['app_secret'], {:scope => 'status_update, publish_stream', :client_options => settings.environment == :production ? {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}} : {}}
end

use Rack::Flash

helpers do
  def is_production?
    settings.environment == :production
  end
  
  def logged_in?
    not @user.nil?
  end
end

before do
  @user = JSON.parse(REDIS.get(session[:user])) if session[:user]
end

get '/' do
  @drawings = REDIS.lrange("drawings", 0, -1).map do |o|
    obj = JSON.parse(o)
    obj.merge({:share_url => "http://#{request.host}/drawings/#{obj[:id]}"})
  end
  
  @colors = EGA_PALETTE
  
  haml :index
end

get '/drawings/:id' do
  begin
    if is_production?
      init_aws
    
      @drawing = AWS::S3::S3Object.find(params[:id], S3_BUCKET)
    else
      @drawing = params[:id]
    end
  rescue => e
    haml :not_found
  end
  
  haml :drawing
end

post '/upload' do
  drawing = "#{Time.now.to_i}.png"
  drawing_obj = {:id => drawing, :url => nil}
  
  begin
    if is_production?
      init_aws

      AWS::S3::S3Object.store(
        drawing,
        decode_png(params[:imageData]),
        S3_BUCKET,
        :access => :public_read)
      
      drawing_obj.merge!({:url => AWS::S3::S3Object.find(drawing, S3_BUCKET).url(:authenticated => false)})
    else
      File.open(File.join(DRAWINGS_PATH, drawing), "w") do |file|
        file << decode_png(params[:imageData])
      end
      
      drawing_obj.merge!({:url => "/images/drawings/#{drawing}"})
    end
    
    drawing_obj.merge!({:user => {:uid => @user['uid'], :first_name => @user['user_info']['first_name'], :image => @user['user_info']['image']}}) if logged_in?
    
    REDIS.lpush "drawings", drawing_obj.to_json
  rescue => e
    "failure: #{e}"
  end
  
  haml :thumb, :layout => false, :locals => drawing_obj.merge({:share_url => "http://#{request.host}/drawings/#{drawing}"})
end

get '/auth/facebook/callback' do
  session[:user] = "user:#{request.env['omniauth.auth']['uid']}"
  REDIS.set session[:user], request.env['omniauth.auth'].to_json
  redirect '/'
end

get '/auth/failure' do
  clear_session
  flash[:error] = 'There was an error trying to access to your Facebook data'
  redirect '/'
end

get '/logout' do
  clear_session
  redirect '/'
end

get '/about' do
  haml :about
end

def clear_session
  session[:user] = nil
end

def init_aws
  AWS::S3::Base.establish_connection!(
    :access_key_id     => ENV['S3_KEY'],
    :secret_access_key => ENV['S3_SECRET']
  )
end

def decode_png(string)
  Base64.decode64(string.gsub(/data:image\/png;base64/, ''))
end