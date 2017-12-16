class SessionsController
  #
  # GET /auth/facebook/callback
  #
  get '/auth/facebook/callback' do
    session[:user] = User.key(request.env['omniauth.auth']['uid'])
    @current_user = User.new(request.env['omniauth.auth'].merge(:key => session[:user])).save
    haml :'auth/callback'
  end

  #
  # GET /auth/twitter/callback
  #
  get '/auth/twitter/callback' do
    session[:twitter_access_token] = {
      :token  => request.env['omniauth.auth']['credentials']['token'],
      :secret => request.env['omniauth.auth']['credentials']['secret']
    }
    redirect params[:origin] || '/'
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
      me = client.selection.me.with_fields('first_name', 'last_name').info!

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
end