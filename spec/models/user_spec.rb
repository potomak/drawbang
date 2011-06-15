require 'spec/spec_helper'

describe User do
  it "should save user" do
    key = "user:123"
    user = {:name => "john"}
    
    REDIS.should_receive(:set).with(key, user.to_json)
    
    User.new(user.merge(:key => key)).save
  end
  
  it "should find user" do
    key = "user:123"
    user = {:name => "john"}
    
    REDIS.should_receive(:get).with(key).and_return(user.to_json)
    JSON.should_receive(:parse).with(user.to_json).and_return(user)
    
    User.find(key).should == user
  end
end