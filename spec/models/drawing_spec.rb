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
    @drawing = {:request_host => "example.com"}
  end
  
  describe "Drawing.find" do
    it "should find drawing" do
      REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(@drawing.to_json)
      JSON.should_receive(:parse).with(@drawing.to_json).and_return(@drawing)

      Drawing.find(@id).should == @drawing
    end

    it "should return nil if it can't find drawing" do
      REDIS.should_receive(:get).with(Drawing.key(@id)).and_return(nil)

      Drawing.find(@id).should == nil
    end
  end
  
  describe "Drawing.destroy" do
    after :each do
      REDIS.should_receive(:del).with(Drawing.key(@id))
      REDIS.should_receive(:lrem).with("drawings", 0, @id)
      
      Drawing.destroy(@id)
    end
    
    it "should remove drawing file on development env, destroy object and remove it from list" do
      Drawing.should_receive(:is_production?).and_return(false)
      File.should_receive(:delete).with(File.join(@test_path, @id))
    end
    
    it "should remove drawing S3 object on production env, destroy object and remove it from list" do
      Drawing.should_receive(:is_production?).and_return(true)
      Drawing.should_receive(:init_aws)
      AWS::S3::S3Object.should_receive(:delete).with(@id, @test_bucket)
    end
  end
  
  describe "drawing.save" do
    after :each do
      REDIS.should_receive(:lpush).with("drawings", @id)
      image = Object.new
      image.should_receive(:to_blob)
      thumbnail = Object.new
      thumbnail.should_receive(:to_blob)
      image.should_receive(:resize).and_return(thumbnail)
      Drawing.should_receive(:process_image).and_return(image)

      Drawing.new(@drawing.merge(:id => @id, :image => {:frame => []})).save
    end
    
    it "should save drawing on development env" do
      file_url = "http://#{@drawing[:request_host]}/images/drawings/#{@id}"
      
      Drawing.should_receive(:save_image).and_return(file_url)
      Drawing.should_receive(:save_image)
      
      @result_drawing = {:url => file_url}
      REDIS.should_receive(:set).with(Drawing.key(@id), @result_drawing.to_json)
    end
    
    it "should save drawing on production env" do
      s3_object_url = "s3_object/public/url"
      
      Drawing.should_receive(:save_image).and_return(s3_object_url)
      Drawing.should_receive(:save_image)
      
      @result_drawing = {:url => s3_object_url}
      REDIS.should_receive(:set).with(Drawing.key(@id), @result_drawing.to_json)
    end
  end
  
  describe "Drawing.save_image" do
    it "should save drawing on production env" do
      Drawing.should_receive(:is_production?).and_return(false)
      
      file = Object.new
      file.should_receive(:'<<').with(nil)
      File.should_receive(:open).with(File.join(@test_path, @id), "w").and_yield(file)
      
      Drawing.save_image(@id, @drawing[:request_host], nil).should == "http://#{@drawing[:request_host]}/images/drawings/#{@id}"
    end
    
    it "should save drawing on development env" do
      Drawing.should_receive(:is_production?).and_return(true)
      Drawing.should_receive(:init_aws)
      AWS::S3::S3Object.should_receive(:store).with(
        @id,
        nil,
        @test_bucket,
        :access => :public_read)
      
      s3_object_url = "s3_object/public/url"
      s3_object = Object.new
      s3_object.should_receive(:url).with(:authenticated => false).and_return(s3_object_url)
      AWS::S3::S3Object.should_receive(:find).with(@id, @test_bucket).and_return(s3_object)
      
      Drawing.save_image(@id, @drawing[:request_host], nil).should == s3_object_url
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
      REDIS.should_receive(:get).exactly(10).times.with(Drawing.key(@id)).and_return(@drawing.to_json)
      JSON.should_receive(:parse).exactly(10).times.with(@drawing.to_json).and_return(@drawing)

      Drawing.all(opts).should == ids.map {|id| @drawing.merge(:id => id, :share_url => "http://#{opts[:host]}/drawings/#{id}")}
    end
  end
end