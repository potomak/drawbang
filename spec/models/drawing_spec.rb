require 'spec/spec_helper'

describe Drawing do
  before :each do
    @id = 123
    @drawing = {:url => "/the/drawing.png"}
  end
  
  it "should find drawing" do
    REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(@drawing.to_json)
    JSON.should_receive(:parse).with(@drawing.to_json).and_return(@drawing)
    
    Drawing.find(@id).should == @drawing
  end
  
  it "should return nil if it can't find drawing" do
    REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(nil)
    
    Drawing.find(@id).should == nil
  end
  
  it "should destroy drawing" do
    REDIS.should_receive(:del).with(Drawing.key(@id))
    REDIS.should_receive(:lrem).with("drawings", 0, @id)
    
    Drawing.destroy(@id)
  end
  
  it "should save drawing" do
    REDIS.should_receive(:set).with(Drawing.key(@id), @drawing.to_json)
    REDIS.should_receive(:lpush).with("drawings", @id)
    
    Drawing.new(@drawing.merge(:id => @id)).save
  end
  
  it "should find all drawings" do
    ids = (0..9).map {@id}
    opts = {
      :page => 0,
      :per_page => 10,
      :host => "example.com"
    }
    
    REDIS.should_receive(:lrange).with("drawings", 0, 9).and_return(ids)
    REDIS.should_receive(:get).exactly(10).times.with(Drawing.key(@id)).and_return(@drawing.to_json)
    JSON.should_receive(:parse).exactly(10).times.with(@drawing.to_json).and_return(@drawing)
    
    Drawing.all(opts).should == ids.map {|id| @drawing.merge(:id => id, :share_url => "http://#{opts[:host]}/drawings/#{id}")}
  end
end