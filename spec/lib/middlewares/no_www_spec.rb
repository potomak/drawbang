require 'spec/spec_helper'

describe NoWWW do
  before(:each) do
    @app = Object.new
    @middleware = NoWWW.new(@app)
  end
  
  describe "call" do
    it "should redirect to non www domain" do
      env = {'HTTP_HOST' => 'www.example.com'}
      url = "http://#{env['HTTP_HOST']}/test?param"
      rack_request = Object.new
      rack_request.should_receive(:url).and_return(url)
      Rack::Request.should_receive(:new).with(env).and_return(rack_request)
      
      @middleware.call(env).should == [301, { 'Location' => 'http://example.com/test?param' }, ['Redirecting...']]
    end
    
    it "should execute call on @app if no www is found" do
      env = {'HTTP_HOST' => 'example.com'}
      
      @app.should_receive(:call).with(env)
      
      @middleware.call(env)
    end
  end
end