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
  options.merge!({:client_options => {:ssl => {:ca_file => '/usr/lib/ssl/certs/ca-certificates.crt'}}})
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
    !@current_user.nil? && @current_user['uid']
  end
end

before do
  # authentication
  if params[:uid] && params[:token]
    user = User.find(params[:uid])
    @current_user = user if user && user['credentials'] && user['credentials']['token'] == params[:token]
  else
    @current_user = User.find_by_key(session[:user]) if session[:user]
  end

  # respond with json if accepted
  content_type :json if json_request?

  # pagination
  @current_page = (params[:page] || 1).to_i
  @page = @current_page - 1
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
  
  @drawings = Drawing.all(:page => @page, :per_page => PER_PAGE, :host => request.host)

  haml :index
end

#
# GET /
#
get '/' do
  @drawings = Drawing.all(:page => @page, :per_page => PER_PAGE, :host => request.host)
  
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
  
  if @user
    @drawings = Drawing.all(:user_id => id, :page => @page, :per_page => PER_PAGE, :host => request.host)
    
    if request.xhr?
      haml :'drawings/gallery', :layout => false
    else
      if json_request?
        {
          :uid        => @user['uid'],
          :first_name => @user['user_info']['first_name'],
          :image      => @user['user_info']['image']
        }.merge({
          :drawings   => {
            :drawings => @drawings,
            :meta     => {:current_page => @current_page}
          }
        }).to_json
      else
        haml :'users/show'
      end
    end
  else
    status 404
  end
end

#
# GET /drawings
#
get '/drawings' do
  content_type :json

  @drawings = Drawing.all(:page => @page, :per_page => API_PER_PAGE, :host => request.host)

  {
    :drawings => @drawings,
    :meta     => {:current_page => @current_page}
  }.to_json
end

#
# GET /drawings/:id
#
get '/drawings/:id' do |id|
  @drawing = Drawing.find(id)
  
  if @drawing
    if json_request?
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
  
  if @drawing
    begin
      image_data = Drawing.image_raw_data(Drawing.thumb_url(@drawing['url']))
      @drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}", :image => image_data)
      
      if json_request?
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
    data = JSON.parse(request.body.read)
    # compose drawing id
    id = "#{Drawing.generate_token}.#{data['image']['frames'] ? "gif" : "png"}"
    # compose drawing object
    drawing = {
      :id           => id,
      :image        => data['image'],
      :request_host => request.host_with_port,
      :created_at   => Time.now.to_i,
      :user => {
        :uid        => @current_user['uid'],
        :first_name => @current_user['user_info']['first_name'],
        :image      => @current_user['user_info']['image']
      }
    }
    # save drawing
    drawing = Drawing.new(drawing).save
    # respond with drawing object augmented by thumb pratial HTML
    drawing.merge!(:id => id, :share_url => "http://#{request.host}/drawings/#{id}")
    drawing.merge(:thumb => haml(:'drawings/thumb', :layout => false, :locals => {:drawing => drawing, :id => 0})).to_json
  rescue => e
    puts "ERROR: #{e}\n#{e.backtrace}"
    status 500
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
# POST /authorize
#
post '/authorize' do
  content_type :json

  begin
    client = FBGraph::Client.new(:client_id => FACEBOOK['app_id'], :secret_id => FACEBOOK['app_secret'], :token => params[:token])
    me = client.selection.me.info!

    raise RuntimeError if params[:uid] != me.data.id

    user = {
      :key      => User.key(me.data.id),
      :uid      => me.data.id,
      :provider => 'facebook',
      :user_info => {
        :first_name => me.data.first_name,
        :last_name  => me.data.last_name,
        :image      => "http://graph.facebook.com/#{me.data.id}/picture?type=square"
      },
      :credentials => {
        :token => params[:token]
      }
    }
  rescue => e
    puts "ERROR: #{e}\n#{e.backtrace}"
    halt 403
  end

  @current_user = User.new(user).save
  @drawings = Drawing.all(:user_id => me.data.id, :page => 0, :per_page => PER_PAGE, :host => request.host)
  
  {
    :uid        => @current_user[:uid],
    :first_name => @current_user[:user_info][:first_name],
    :image      => @current_user[:user_info][:image]
  }.merge({
    :drawings   => {
      :drawings => @drawings,
      :meta     => {:current_page => 1}
    }
  }).to_json
end

#
# GET /about
#
get '/about' do
  haml :about
end