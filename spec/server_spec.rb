require 'spec/spec_helper'

describe "Draw! app" do
  include Rack::Test::Methods

  # see https://groups.google.com/forum/#!topic/sinatrarb/qd5PaQYxs6E
  # source https://gist.github.com/375973
  class SessionData
    def initialize(cookies)
      @cookies = cookies
      @data = cookies['rack.session']
      if @data
        @data = @data.unpack("m*").first
        @data = Marshal.load(@data)
      else
        @data = {}
      end
    end

    def [](key)
      @data[key]
    end

    def []=(key, value)
      @data[key] = value
      session_data = Marshal.dump(@data)
      session_data = [session_data].pack("m*")
      @cookies.merge("rack.session=#{Rack::Utils.escape(session_data)}", URI.parse("//example.org//"))
      raise "session variable not set" unless @cookies['rack.session'] == session_data
    end
  end

  def session
    SessionData.new(rack_test_session.instance_variable_get(:@rack_mock_session).cookie_jar)
  end

  def app
    @app ||= Sinatra::Application
  end
  
  describe "POST /" do
    it "should be tested"
  end

  describe "GET /" do
    it "should respond" do
      Drawing.should_receive(:all).and_return([])
      get '/'
      last_response.should be_ok
    end
    
    it "should create session" do
      get '/'
      last_response.header['Set-Cookie'].should match /rack\.session/
    end
    
    it "should set session expiration date" do
      get '/'
      last_response.header['Set-Cookie'].should match /expires/i
    end
  end
  
  describe "GET /feed.rss" do
    it "should respond" do
      Drawing.should_receive(:all).and_return([])
      header 'Accept', 'application/rss+xml'
      get '/'
      last_response.should be_ok
    end
  end
  
  describe "GET /users/123" do
    before :each do
      @id = "123"
      @user = {:uid => "123", 'user_info' => {'first_name' => "John"}}
      @drawing = {'url' => "/the/drawing.png"}
    end
    
    describe "user found" do
      before(:each) do
        User.should_receive(:find).with(@id).and_return(@user)
      end
      
      it "should respond 200 if a user is found" do
        get "/users/#{@id}"
        last_response.should be_ok
      end
      
      it "should respond with json if accept header is set to 'application/json'" do
        header 'Accept', 'application/json'
        get "/users/#{@id}"
        last_response.header['Content-type'].should == 'application/json'
      end

      it "should display user info" do
        get "/users/#{@id}"
        last_response.should match @user['user_info']['first_name']
      end

      it "should display user gallery" do
        get "/users/#{@id}"
        last_response.should match @user['user_info']['first_name']
      end
      
    end
    
    describe "user not found" do
      before(:each) do
        User.should_receive(:find).with(@id).and_return(nil)
      end
      
      it "should respond 404 if a user is not found" do
        get "/users/#{@id}"
        last_response.should be_not_found
      end
      
      it "should display 'not found'" do
        get "/users/#{@id}"
        last_response.should match /not found/
      end
    end
  end
  
  describe "GET /drawings/123.png" do
    before :each do
      @id = "123.png"
      @drawing = {'url' => "/the/drawing.png"}
    end
    
    describe "drawing found" do
      before(:each) do
        Drawing.should_receive(:find).with(@id).and_return(@drawing)
      end
      
      it "should respond 200 if a drawing is found" do
        get "/drawings/#{@id}"
        last_response.should be_ok
      end
      
      it "should respond with json if accept header is set to 'application/json'" do
        header 'Accept', 'application/json'
        get "/drawings/#{@id}"
        last_response.header['Content-type'].should == 'application/json'
      end

      it "should display drawing" do
        get "/drawings/#{@id}"
        last_response.should match @drawing['url']
      end
    end
    
    describe "drawing not found" do
      before(:each) do
        Drawing.should_receive(:find).with(@id).and_return(nil)
        get "/drawings/#{@id}"
      end
      
      it "should respond 404 if a drawing is not found" do
        last_response.should be_not_found
      end
      
      it "should display 'not found'" do
        last_response.should match /not found/
      end
    end
  end
  
  describe "POST /upload" do
    describe "guest user" do
      before(:each) do
        @user = nil
        post '/upload'
      end
      
      it "should redirect to '/'" do
        last_response.should be_redirect
        last_response.header['Location'].should match /\//
      end
    end
    
    describe "authenticated user" do
      before(:each) do
        @user_id = "user:xxx"
        session[:user] = @user_id
        @user = {:uid => "123", 'user_info' => {'first_name' => "John"}}
        User.should_receive(:find_by_key).with(@user_id).and_return(@user)
      end
      
      it "should be tested"
      
      it "should respond with json" do
        post '/upload', {}.to_json
        last_response.header['Content-type'].should == 'application/json'
      end
    end
  end
  
  describe "GET /auth/facebook/callback" do
    # #
    # # GET /auth/facebook/callback
    # #
    # get '/auth/facebook/callback' do
    #   session[:user] = "user:#{request.env['omniauth.auth']['uid']}"
    #   @user = User.new(request.env['omniauth.auth'].merge(:key => session[:user])).save
    #   haml :callback
    # end
    
    before(:each) do
      get '/auth/facebook/callback'
    end
    
    it "should set user auth session" do
      last_request.session['user'].should match /user:/
    end
    
    it "should save authenticated user" do
      pending
      
      @user = Object.new
      @user.should_receive(:save)
      User.should_receive(:new).and_return(@user)
    end
    
    it "should render callback template" do
      last_response.body.should match /window\.close/
    end
  end
  
  describe "GET /auth/failure" do
    before(:each) do
      get '/auth/failure'
    end
    
    it "should show an error message" do
      last_response.body.should match /There was an error trying to access to your Facebook data/
    end
    
    it "should clear session" do
      last_request.session['user'].should be_nil
    end
  end
  
  describe "GET /logout" do
    it "should redirect" do
      get '/logout'
      last_response.should be_redirect
    end
    
    it "should redirect to origin if param[:origin] is set" do
      get '/logout', :origin => "/origin"
      last_response.should be_redirect
      last_response.header['Location'].should match /\/origin/
    end
    
    it "should clear session" do
      get '/logout'
      last_request.session['user'].should be_nil
    end
  end
  
  describe "GET /about" do
    before(:each) do
      get '/about'
    end
    
    it "should respond" do
      last_response.should be_ok
    end
    
    it "should render about template" do
      last_response.body.should match /Credits/
    end
  end
  
  describe "DELETE /drawings/123.png" do
    before(:each) do
      @id = "123.png"
    end
    
    describe "guest user" do
      before(:each) do
        @user = nil
        delete '/drawings/123.png'
      end
      
      it "should redirect to '/drawings/123.png'" do
        last_response.should be_redirect
        last_response.header['Location'].should match /\/drawings\/123\.png/
      end
    end
    
    describe "authenticated user" do
      before(:each) do
        @user_id = "user:xxx"
        session[:user] = @user_id
        @user = {:uid => "123", 'user_info' => {'first_name' => "John"}}
        User.should_receive(:find_by_key).with(@user_id).and_return(@user)
      end

      describe "drawing not found" do
        before(:each) do
          Drawing.should_receive(:find).with(@id).and_return(nil)
          delete '/drawings/123.png'
        end

        it "should respond 404 if a drawing is not found" do
          last_response.should be_not_found
        end

        it "should display 'not found'" do
          last_response.should match /not found/
        end
      end
      
      describe "drawing found" do
        describe "unauthorized user" do
          before(:each) do
            @drawing = {}
            Drawing.should_receive(:find).with(@id).and_return(@drawing)
            delete '/drawings/123.png'
          end
          
          it "should respond 403" do
            last_response.status.should == 403
          end

          it "should display 'Access forbidden'" do
            last_response.should match /Access forbidden/
          end
        end
        
        describe "authorized user" do
          before(:each) do
            @drawing = {'user' => @user}
            Drawing.should_receive(:find).with(@id).and_return(@drawing)
            Drawing.should_receive(:destroy).with(@id, @user['uid'])
            delete '/drawings/123.png'
          end
          
          it "should redirect to '/'" do
            last_response.should be_redirect
            last_response.header['Location'].should match /\//
          end
        end
      end
    end
  end
end