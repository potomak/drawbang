require 'spec/spec_helper'

describe Drawing do
  before :all do
    # development env
    @test_path = "test"
    Object.const_set("DRAWINGS_PATH", @test_path)
    
    # production env
    @test_bucket = "test"
    Object.const_set("S3_BUCKET", @test_bucket)
  end
  
  before :each do
    @id = "123.png"
    @drawing = {
      :request_host => "example.com",
      :user => { :uid => "1423" }
    }
  end
  
  describe "Drawing.find" do
    it "should find drawing" do
      REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(@drawing.to_json)
      JSON.should_receive(:parse).with(@drawing.to_json).and_return(@drawing)

      Drawing.find(@id).should == @drawing.merge(:id => @id)
    end

    it "should return nil if it can't find drawing" do
      REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(nil)

      Drawing.find(@id).should == nil
    end
  end
  
  describe "Drawing.destroy" do
    it "should remove drawing file, destroy object and remove it from list" do
      Drawing.should_receive(:delete_file).with(@id)
      REDIS.should_receive(:del).with(Drawing.key(@id))
      REDIS.should_receive(:lrem).with(Drawing.list(@drawing[:user][:uid]), 0, @id)
      REDIS.should_receive(:lrem).with(Drawing.list, 0, @id)
      
      Drawing.destroy(@id, @drawing[:user][:uid])
    end
  end
  
  describe "drawing.save" do
    it "should save drawing" do
      image_object = Object.new
      image_object_blob = Object.new
      image_object.should_receive(:to_blob).and_return(image_object_blob)
      thumbnail_object = Object.new
      thumbnail_object_blob = Object.new
      thumbnail_object.should_receive(:to_blob).and_return(thumbnail_object_blob)
      file_url = "http://#{@drawing[:request_host]}/images/drawings/#{@id}"
      
      Drawing.should_receive(:process_image).and_return(image_object)
      Drawing.should_receive(:process_thumbnail).and_return(thumbnail_object)
      
      Drawing.should_receive(:save_file).with(@id, @drawing[:request_host], image_object_blob).and_return(file_url)
      Drawing.should_receive(:save_file).with("#{@id}_64.png", @drawing[:request_host], thumbnail_object_blob)
      
      REDIS.should_receive(:lpush).with(Drawing.list(@drawing[:user][:uid]), @id)
      REDIS.should_receive(:lpush).with(Drawing.list, @id)
      
      @result_drawing = {:url => file_url, :user => { :uid => "1423" }}
      REDIS.should_receive(:set).with(Drawing.key(@id), @result_drawing.to_json)
      
      Drawing.new(@drawing.merge(:id => @id, :image => {:frame => []})).save
    end
  end
  
  describe "Drawing.all" do
    it "should find all drawings" do
      ids = (0..9).map {@id}
      opts = {
        :page => 0,
        :per_page => 10,
        :host => "example.com"
      }

      REDIS.should_receive(:lrange).with("drawings", 0, 9).and_return(ids)
      Drawing.should_receive(:find).exactly(10).times.with(@id, :shallow => true).and_return(@drawing)

      Drawing.all(opts).should == ids.map {|id| @drawing.merge(:id => id, :share_url => "http://#{opts[:host]}/drawings/#{id}")}
    end
  end
  
  describe "Drawing.key" do
    it "should return drawing key given id" do
      Drawing.key("123").should == "drawing:123"
    end
  end
  
  describe "Drawing.list" do
    it "should return all drawings list key" do
      Drawing.list.should == "drawings"
    end
    
    it "should return user drawings list key" do
      Drawing.list("123").should == "drawings:user:123"
    end
  end
  
  describe "Drawing.generate_token" do
    it "should return a random hash string" do
      random_hash = "a random hash"
      Digest::SHA1.should_receive(:hexdigest).and_return(random_hash)
      
      Drawing.generate_token.should == random_hash
    end
  end
end