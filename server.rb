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
require 'fbgraph'

require 'models/user'
require 'models/drawing'
require 'lib/middlewares/no_www'
require 'lib/middlewares/no_heroku'

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
  options = {:scope => '', :display => "popup"}
  # NOTE: https://github.com/technoweenie/faraday/wiki/Setting-up-SSL-certificates
  options.merge!({:client_options => {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}}}) if settings.environment == :production
  provider :facebook, FACEBOOK['app_id'], FACEBOOK['app_secret'], options
end

use Rack::Flash
use Rack::MethodOverride

use NoWWW
use NoHeroku

helpers do
  def is_production?
    :production == settings.environment
  end
  
  def logged_in?
    not @user.nil?
  end
end

before do
  # authentication
  @user = User.find(session[:user]) if session[:user]
  # pagination
  @current_page = (params[:page] || 1).to_i
  @page = @current_page - 1
end

def root_action
  @drawings = Drawing.all(:page => @page, :per_page => PER_PAGE, :host => request.host)
  @colors = EGA_PALETTE
end

def clear_session
  session[:user] = nil
end

#
# POST /
#
post '/' do
  # parse facebook signed_request
  data = FBGraph::Canvas.parse_signed_request(FACEBOOK['app_secret'], params[:signed_request])
  
  # log in users who have allowed draw! app to access their facebook data
  if data['user_id']
    session[:user] = "user:#{data['user_id']}"
    @user = User.update(session[:user], :credentials => {:token => data['oauth_token']})
  end
  
  root_action

  haml :index
end

#
# GET /
#
get '/' do
  root_action
  
  if request.xhr?
    haml :'shared/gallery', :layout => false
  else
    haml :index
  end
end

#
# GET /feed.rss
#
get '/feed.rss', :provides => 'rss' do
  @drawings = Drawing.all(:page => 0, :per_page => PER_PAGE, :host => request.host)
  builder :feed
end

#
# GET /users/:id
#
get '/users/:id' do
  @user = User.find("user:#{params[:id]}")
  
  if @user
    @drawings = Drawing.all(:user_id => params[:id], :page => @page, :per_page => PER_PAGE, :host => request.host)
    haml :'users/show'
  else
    haml :'users/not_found'
  end
end

#
# GET /drawings/:id
#
get '/drawings/:id' do
  @drawing = Drawing.find(params[:id])
  
  if @drawing
    @drawing.merge!(:id => params[:id], :share_url => "http://#{request.host}/drawings/#{params[:id]}")
    haml :'drawings/show'
  else
    haml :'drawings/not_found'
  end
end

#
# DELETE /drawings/:id
#
delete '/drawings/:id' do |id|
  redirect "/drawings/#{id}" unless logged_in?
  @drawing = Drawing.find(id)
  redirect "/drawings/#{id}" unless @drawing && @drawing['user']
  
  if @drawing['user']['uid'] == @user['uid']
    begin
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

#
# POST /upload
#
post '/upload' do
  redirect '/' unless logged_in?
  content_type :json
  
  data = JSON.parse(request.env["rack.input"].read)
  
  # compose drawing object
  id = "#{Time.now.to_i}.#{data['image']['frames'] ? "gif" : "png"}"
  drawing = {
    :id => id,
    :image => data['image'],
    :request_host => request.host_with_port
  }
  
  # add user info if present
  drawing.merge!(
    :user => {
      :uid => @user['uid'],
      :first_name => @user['user_info']['first_name'],
      :image => @user['user_info']['image']
    }
  ) if logged_in?
  
  begin
    drawing = Drawing.new(drawing).save
    drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}")
    drawing.merge(:thumb => haml(:'shared/thumb', :layout => false, :locals => drawing)).to_json
  rescue => e
    "failure: #{e}\n#{e.backtrace}".to_json
  end
end

#
# GET /auth/facebook/callback
#
get '/auth/facebook/callback' do
  session[:user] = "user:#{request.env['omniauth.auth']['uid']}"
  @user = User.new(request.env['omniauth.auth'].merge(:key => session[:user])).save
  haml :callback
end

#
# GET /auth/failure
#
get '/auth/failure' do
  clear_session
  flash.now[:error] = 'There was an error trying to access to your Facebook data.<br/>Please log in to save your drawing.'
  haml :failure
end

#
# GET /logout
#
get '/logout' do
  clear_session
  redirect params[:origin] || '/'
end

#
# GET /about
#
get '/about' do
  haml :about
end