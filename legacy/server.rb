require 'rubygems'
require 'bundler'

Bundler.require

require 'models/user'
require 'models/drawing'
require 'lib/middlewares/no_heroku'

configure do
  require 'version'
  require 'config/config'
  require "config/environments/#{settings.environment}"

  set :haml, :format => :html5

  # NOTE: this is the new form of the :sessions setting
  #set :sessions, :expire_after => 2592000 #30 days in seconds
  use Rack::Session::Cookie, :expire_after => 2592000,
                             :secret       => settings.session_secret
end

use OmniAuth::Builder do
  options = {:scope => 'publish_actions', :display => 'popup'}
  # NOTE: https://github.com/technoweenie/faraday/wiki/Setting-up-SSL-certificates
  options.merge!(:client_options => {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}})
  provider :facebook, FACEBOOK['app_id'],      FACEBOOK['app_secret'], options
  provider :twitter,  TWITTER['consumer_key'], TWITTER['consumer_secret']
end

use Rack::Flash
use Rack::MethodOverride

use NoHeroku

helpers do
  def is_production?
    :production == settings.environment
  end

  def logged_in?
    !@current_user.nil? && @current_user['uid']
  end
end

# authentication
before do
  if params[:uid] && params[:token]
    user          = User.find(params[:uid])
    @current_user = user if user && user['credentials'] && user['credentials']['token'] == params[:token]
  else
    @current_user = User.find_by_key(session[:user]) if session[:user]
  end
end

# respond with json if accepted
before do
  content_type :json if json_request?
end

# pagination
before do
  @current_page = (params[:page] || 1).to_i
  @page         = @current_page - 1
end

not_found do
  json_request? ? "not found".to_json : haml(:'shared/not_found')
end

error 403 do
  json_request? ? "access forbidden".to_json : haml(:'shared/access_forbidden')
end

error 500 do
  json_request? ? "application error".to_json : haml(:'shared/application_error')
end

def json_request?
  request.accept.include? 'application/json'
end

def clear_session
  session[:user] = nil
end

def auth_or_redirect(path)
  unless logged_in?
    if json_request?
      halt 403
    else
      flash[:error] = 'Please log in to perform this operation'
      redirect path
    end
  end
end

require 'controllers/root_controller'
require 'controllers/users_controller'
require 'controllers/drawings_controller'
require 'controllers/sessions_controller'
require 'controllers/pages_controller'
