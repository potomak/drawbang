require File.dirname(__FILE__) + '/spec_helper'

describe "Draw! app" do
  include Rack::Test::Methods

  def app
    @app ||= Sinatra::Application
  end

  it "should respond to GET /" do
    get '/'
    last_response.should be_ok
  end
  
  it "should respond to GET /about" do
    get '/'
    last_response.should be_ok
  end
  
  it "should respond to GET /drawing/123.png" do
    get '/'
    last_response.should be_ok
  end
end