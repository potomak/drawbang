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
    haml :'drawings/gallery', :locals => {:drawings => @drawings}, :layout => false
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