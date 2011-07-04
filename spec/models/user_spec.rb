require 'spec/spec_helper'

describe User do
  before :each do
    @key = "user:123"
    @user = {:name => "john"}
  end
  
  describe "user.save" do
    it "should return user" do
      REDIS.should_receive(:set).with(@key, @user.to_json).and_return("OK")

      User.new(@user.merge(:key => @key)).save.should == @user
    end
  end
  
  describe "User.find" do
    it "should find user" do
      REDIS.should_receive(:get).with(@key).and_return(@user.to_json)
      JSON.should_receive(:parse).with(@user.to_json).and_return(@user)

      User.find(@key).should == @user
    end

    it "should return nil if it can't find user" do
      REDIS.should_receive(:get).with(@key).and_return(nil)

      User.find(@key).should == nil
    end
  end
end