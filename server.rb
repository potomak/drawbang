require 'rubygems'
require 'sinatra'
require 'sinatra/content_for'
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
  options = {:scope => 'status_update, publish_stream'}
  options.merge!({:client_options => {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}}}) if settings.environment == :production
  provider :facebook, FACEBOOK['app_id'], FACEBOOK['app_secret'], options
end

use Rack::Flash
use Rack::MethodOverride

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
  @current_page = (params[:page] || 1).to_i
  @page = @current_page - 1
end

get '/' do
  @drawings = drawings_list
  @colors = EGA_PALETTE
  
  haml :index
end

get '/drawings' do
  content_type :json
  
  drawings_list.map do |obj|
    obj.merge(:thumb => haml(:thumb, :layout => false, :locals => obj))
  end.to_json
end

get '/drawings/:id' do
  @drawing = REDIS.get("drawing:#{params[:id]}")
  
  if @drawing
    @drawing = JSON.parse(@drawing).merge({:id => params[:id], :share_url => "http://#{request.host}/drawings/#{params[:id]}"})
    haml :drawing
  else
    haml :not_found
  end
end

delete '/drawings/:id' do |id|
  redirect "/drawings/#{id}" unless logged_in?
  @drawing = JSON.parse(REDIS.get("drawing:#{id}"))
  redirect "/drawings/#{id}" unless @drawing && @drawing['user']
  
  if @drawing['user']['uid'] == @user['uid']
    begin
      if is_production?
        init_aws
        
        AWS::S3::S3Object.delete id, S3_BUCKET
      else
        File.delete(File.join(DRAWINGS_PATH, id))
      end
      
      REDIS.del("drawing:#{id}")
      REDIS.lrem("drawings", 0, id)
    rescue => e
      "failure: #{e}"
    end
    
    flash[:notice] = 'Drawing deleted'
    redirect '/'
  else
    flash[:error] = 'There was an error trying delete this drawing'
  end
  
  redirect "/drawings/#{id}"
end

post '/upload' do
  content_type :json
  
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
      
      drawing_obj.merge!({:url => "http://#{request.host_with_port}/images/drawings/#{drawing}"})
    end
    
    drawing_obj.merge!({:user => {:uid => @user['uid'], :first_name => @user['user_info']['first_name'], :image => @user['user_info']['image']}}) if logged_in?
    
    REDIS.lpush "drawings", drawing
    REDIS.set "drawing:#{drawing}", drawing_obj.to_json
    
    drawing_obj.merge(
      :thumb => haml(:thumb, :layout => false, :locals => drawing_obj.merge!({:share_url => "http://#{request.host}/drawings/#{drawing}"}))
    ).to_json
  rescue => e
    "failure: #{e}".to_json
  end
end

get '/auth/facebook/callback' do
  session[:user] = "user:#{request.env['omniauth.auth']['uid']}"
  REDIS.set session[:user], request.env['omniauth.auth'].to_json
  redirect request.env['omniauth.origin'] || '/'
end

get '/auth/failure' do
  clear_session
  flash[:error] = 'There was an error trying to access to your Facebook data'
  redirect params[:origin] || '/'
end

get '/logout' do
  clear_session
  redirect params[:origin] || '/'
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

def drawings_list
  REDIS.lrange("drawings", @page*(PER_PAGE-1), (@page*(PER_PAGE-1))+(PER_PAGE-1)).map do |id|
    JSON.parse(REDIS.get("drawing:#{id}")).merge(:id => id, :share_url => "http://#{request.host}/drawings/#{id}")
  end
end