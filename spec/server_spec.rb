require 'spec/spec_helper'

describe "Draw! app" do
  include Rack::Test::Methods

  def app
    @app ||= Sinatra::Application
  end
  
  it "should respond to POST /"

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
  
  describe "GET /drawings/123.png" do
    before :each do
      @id = "123.png"
      @drawing = {'url' => "/the/drawing.png"}
    end
    
    it "should respond" do
      Drawing.should_receive(:find).with(@id)
      get "/drawings/#{@id}"
      last_response.should be_ok
    end

    it "should display drawing" do
      Drawing.should_receive(:find).with(@id).and_return(@drawing)
      get "/drawings/#{@id}"
      last_response.should match @drawing['url']
    end

    it "should display 'not found'" do
      Drawing.should_receive(:find).with(@id).and_return(nil)
      get "/drawings/#{@id}"
      last_response.should match /not found/
    end
  end
  
  it "should respond to POST /upload"
  it "should respond to GET /auth/facebook/callback"
  it "should respond to GET /auth/failure"
  
  describe "GET /logout" do
    it "should redirect" do
      get '/logout'
      last_response.should be_redirect
    end
    
    # see https://groups.google.com/d/topic/sinatrarb/CMlBimoHiPg/discussion
    it "should clear session"
  end
  
  describe "GET /about" do
    it "should respond" do
      get '/about'
      last_response.should be_ok
    end
  end
  
  describe "DELETE /drawings/123.png" do
  end
end