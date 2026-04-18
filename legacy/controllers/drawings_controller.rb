class DrawingsController
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
  # GET /drawings/:id/fork
  #
  get '/drawings/:id/fork' do |id|
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
  # GET /drawings/:id/use_as_twitter_avatar
  #
  get '/drawings/:id/use_as_twitter_avatar' do |id|
    @drawing = Drawing.find(id)
    
    if @drawing
      if session[:twitter_access_token]
        begin
          Twitter.configure do |config|
            config.consumer_key = TWITTER['consumer_key']
            config.consumer_secret = TWITTER['consumer_secret']
            config.oauth_token = session[:twitter_access_token][:token]
            config.oauth_token_secret = session[:twitter_access_token][:secret]
          end
          
          io = open(URI.parse(@drawing['url']))
          def io.original_filename; base_uri.path.split('/').last; end
          io.original_filename.blank? ? nil : io

          Twitter.update_profile_image(io)

          if json_request?
            @drawing.to_json
          else
            @drawing.merge!(:share_url => "http://#{request.host}/drawings/#{id}")
            haml :'drawings/use_as_twitter_avatar'
          end
        rescue => e
          puts "ERROR: #{e}"
          status 500
        end
      else
        redirect "/auth/twitter?origin=/drawings/#{id}/use_as_twitter_avatar"
      end
    else
      status 404
    end
  end

  #
  # POST /drawings/:id/tweet
  #
  post '/drawings/:id/tweet' do |id|
    @drawing = Drawing.find(id)
    
    if @drawing
      if session[:twitter_access_token]
        begin
          Twitter.configure do |config|
            config.consumer_key = TWITTER['consumer_key']
            config.consumer_secret = TWITTER['consumer_secret']
            config.oauth_token = session[:twitter_access_token][:token]
            config.oauth_token_secret = session[:twitter_access_token][:secret]
          end

          Twitter.update(params[:tweet_text])

          if 'yes' == params[:follow_drawbang]
            Twitter.follow('drawbang')
          end

          if json_request?
            @drawing.to_json
          else
            redirect "/drawings/#{id}"
          end
        rescue => e
          puts "ERROR: #{e}"
          status 500
        end
      else
        redirect "/auth/twitter?origin=/drawings/#{id}/use_as_twitter_avatar"
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
    @drawing = Drawing.find(id, :shallow => true)
    
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
        :parent       => data['parent'],
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
end