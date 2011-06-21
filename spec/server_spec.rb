require 'spec/spec_helper'

describe "Draw! app" do
  include Rack::Test::Methods

  def app
    @app ||= Sinatra::Application
  end

  describe "GET /" do
    ['text/html', 'application/rss+xml'].each do |format|
      it "should respond to #{format} request" do
        Drawing.should_receive(:all).and_return([])
        header 'Accept', format
        get '/'
        last_response.should be_ok
      end
    end
  end
  
  it "should respond to GET /about" do
    get '/about'
    last_response.should be_ok
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
  
  # it "should respond to POST /upload" do
  #   post '/upload'
  #   
  #   last_response.should be_ok
  # end
end