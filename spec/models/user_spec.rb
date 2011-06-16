require 'spec/spec_helper'

describe User do
  before :each do
    @key = "user:123"
    @user = {:name => "john"}
  end
  
  it "should save user" do
    REDIS.should_receive(:set).with(@key, @user.to_json)
    
    User.new(@user.merge(:key => @key)).save
  end
  
  it "should find user" do
    REDIS.should_receive(:get).with(@key).and_return(@user.to_json)
    JSON.should_receive(:parse).with(@user.to_json).and_return(@user)
    
    User.find(@key).should == @user
  end
end