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

require 'models/user'
require 'models/drawing'
require 'redirect'

configure do
  require 'version'
  require 'config/config'
  require "config/#{settings.environment}"
  
  set :haml, :format => :html5
  
  # NOTE: this is the new form of the :sessions setting
  #set :sessions, :expire_after => 2592000 #30 days in seconds
  use Rack::Session::Cookie, :expire_after => 2592000,
                             :secret => settings.session_secret
end

use OmniAuth::Builder do
  options = {:scope => 'status_update, publish_stream', :display => "popup"}
  options.merge!({:client_options => {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}}}) if settings.environment == :production
  provider :facebook, FACEBOOK['app_id'], FACEBOOK['app_secret'], options
end

use Rack::Flash
use Rack::MethodOverride

use Redirect

helpers do
  def is_production?
    settings.environment == :production
  end
  
  def logged_in?
    not @user.nil?
  end
end

before do
  @user = User.find(session[:user]) if session[:user]
  @current_page = (params[:page] || 1).to_i
  @page = @current_page - 1
end

get '/' do
  @drawings = Drawing.all(:page => @page, :per_page => PER_PAGE, :host => request.host)
  @colors = EGA_PALETTE
  
  if request.xhr?
    haml :gallery, :layout => false
  else
    haml :index
  end
end

get '/feed.rss', :provides => 'rss' do
  @drawings = Drawing.all(:page => 0, :per_page => PER_PAGE, :host => request.host)
  builder :feed
end

get '/drawings/:id' do
  @drawing = Drawing.find(params[:id])
  
  if @drawing
    @drawing.merge!(:id => params[:id], :share_url => "http://#{request.host}/drawings/#{params[:id]}")
    haml :drawing
  else
    haml :not_found
  end
end

delete '/drawings/:id' do |id|
  redirect "/drawings/#{id}" unless logged_in?
  @drawing = Drawing.find(id)
  redirect "/drawings/#{id}" unless @drawing && @drawing['user']
  
  if @drawing['user']['uid'] == @user['uid']
    begin
      if is_production?
        init_aws
        
        AWS::S3::S3Object.delete id, S3_BUCKET
      else
        File.delete(File.join(DRAWINGS_PATH, id))
      end
      
      Drawing.destroy(id)
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
  
  id = "#{Time.now.to_i}.png"
  drawing = {:id => id, :url => nil}
  
  begin
    if is_production?
      init_aws

      AWS::S3::S3Object.store(
        id,
        decode_png(params[:imageData]),
        S3_BUCKET,
        :access => :public_read)
      
      drawing.merge!({:url => AWS::S3::S3Object.find(id, S3_BUCKET).url(:authenticated => false)})
    else
      File.open(File.join(DRAWINGS_PATH, id), "w") do |file|
        file << decode_png(params[:imageData])
      end
      
      drawing.merge!({:url => "http://#{request.host_with_port}/images/drawings/#{id}"})
    end
    
    drawing.merge!(:user => {:uid => @user['uid'], :first_name => @user['user_info']['first_name'], :image => @user['user_info']['image']}) if logged_in?
    
    Drawing.new(drawing).save
    
    drawing.merge(
      :thumb => haml(:thumb, :layout => false, :locals => drawing.merge!({:share_url => "http://#{request.host}/drawings/#{id}"}))
    ).to_json
  rescue => e
    "failure: #{e}".to_json
  end
end

get '/auth/facebook/callback' do
  session[:user] = "user:#{request.env['omniauth.auth']['uid']}"
  User.new(request.env['omniauth.auth'].merge(:key => session[:user])).save
  haml :callback
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