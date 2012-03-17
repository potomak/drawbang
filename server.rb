require 'rubygems'
require 'bundler'

Bundler.require

require 'models/user'
require 'models/drawing'
require 'lib/middlewares/no_www'
require 'lib/middlewares/no_heroku'

configure do
  require 'version'
  require 'config/config'
  require "config/environments/#{settings.environment}"
  
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
    not @current_user.nil?
  end
end

before do
  # authentication
  @current_user = User.find_by_key(session[:user]) if session[:user]
  # pagination
  @current_page = (params[:page] || 1).to_i
  @page = @current_page - 1
end

not_found do
  case request.accept
  when 'application/json'
    "not found".to_json
  else
    haml :'shared/not_found'
  end
end

error 403 do
  case request.accept
  when 'application/json'
    "access forbidden".to_json
  else
    haml :'shared/access_forbidden'
  end
end

error 500 do
  case request.accept
  when 'application/json'
    "application error".to_json
  else
    haml :'shared/application_error'
  end
end

def root_action
  @drawings = Drawing.all(:page => @page, :per_page => PER_PAGE, :host => request.host)
end

def clear_session
  session[:user] = nil
end

def auth_or_redirect(path)
  unless logged_in?
    flash[:error] = 'Please log in to perform this operation'
    redirect path
  end
end

#
# POST /
#
post '/' do
  # parse facebook signed_request
  data = FBGraph::Canvas.parse_signed_request(FACEBOOK['app_secret'], params[:signed_request])
  puts "signed_request data: #{data.inspect}"
  
  # log in users who have allowed draw! app to access their facebook data
  if data['user_id']
    session[:user] = User.key(data['user_id'])
    @current_user = User.update(session[:user], :credentials => {:token => data['oauth_token']})
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
    haml :'drawings/gallery', :layout => false
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
get '/users/:id' do |id|
  @user = User.find(id)
  content_type :json if request.accept.include? 'application/json'
  
  if @user
    @drawings = Drawing.all(:user_id => id, :page => @page, :per_page => PER_PAGE, :host => request.host)
    
    if request.xhr?
      haml :'drawings/gallery', :layout => false
    else
      case request.accept.first
      when 'application/json'
        @user.merge(:drawings => @drawings).to_json
      else
        haml :'users/show'
      end
    end
  else
    status 404
  end
end

#
# GET /drawings/:id
#
get '/drawings/:id' do |id|
  @drawing = Drawing.find(id)
  content_type :json if request.accept.include? 'application/json'
  
  if @drawing
    case request.accept.first
    when 'application/json'
      @drawing.to_json
    else
      @drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}")
      haml :'drawings/show'
    end
  else
    status 404
  end
end

#
# POST /drawings/:id/fork
#
post '/drawings/:id/fork' do |id|
  @drawing = Drawing.find(id)
  content_type :json if request.accept.include? 'application/json'
  
  if @drawing
    begin
      @drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}", :image => Drawing.image_raw_data(@drawing['url']))
      
      case request.accept.first
      when 'application/json'
        @drawing.to_json
      else
        haml :'drawings/fork'
      end
    rescue => e
      puts "ERROR: #{e}"
      status 500
    end
  else
    status 404
  end
end

#
# DELETE /drawings/:id
#
delete '/drawings/:id' do |id|
  auth_or_redirect "/drawings/#{id}"
  
  # find drawing
  @drawing = Drawing.find(id)
  
  if @drawing
    if @drawing['user'] && @drawing['user']['uid'] == @current_user['uid']
      begin
        Drawing.destroy(id, @current_user['uid'])
        flash[:notice] = "Drawing deleted"
        redirect '/'
      rescue => e
        puts "ERROR: #{e}"
        status 500
      end
    else
      status 403
    end
  else
    status 404
  end
end

#
# POST /upload
#
post '/upload' do
  auth_or_redirect '/'
  content_type :json
  
  begin
    # get access to raw POST data
    data = JSON.parse(request.env["rack.input"].read)
    # compose drawing id
    id = "#{Drawing.generate_token}.#{data['image']['frames'] ? "gif" : "png"}"
    # compose drawing object
    drawing = {
      :id => id,
      :image => data['image'],
      :request_host => request.host_with_port,
      :created_at => Time.now.to_i,
      :user => {
        :uid => @current_user['uid'],
        :first_name => @current_user['user_info']['first_name'],
        :image => @current_user['user_info']['image']
      }
    }
    # save drawing
    drawing = Drawing.new(drawing).save
    # respond with drawing object augmented by thumb pratial HTML
    drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}")
    drawing.merge(:thumb => haml(:'drawings/thumb', :layout => false, :locals => {:drawing => drawing, :id => 0})).to_json
  rescue => e
    puts "ERROR: #{e}\n#{e.backtrace}"
    "Sorry, an error occurred while processing your request.".to_json
  end
end

#
# GET /auth/facebook/callback
#
get '/auth/facebook/callback' do
  session[:user] = User.key(request.env['omniauth.auth']['uid'])
  @current_user = User.new(request.env['omniauth.auth'].merge(:key => session[:user])).save
  haml :'auth/callback'
end

#
# GET /auth/failure
#
get '/auth/failure' do
  clear_session
  flash.now[:error] = 'There was an error trying to access to your Facebook data.<br/>Please log in to save your drawing.'
  haml :'auth/failure'
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