require 'spec/spec_helper'

describe Storage::Aws do
  include Storage::Aws::ClassMethods
  
  before :all do
    # production env
    @test_bucket = "test"
    Object.const_set("S3_BUCKET", @test_bucket)
    @test_aws_credentials = {'S3_KEY' => 'key', 'S3_SECRET' => 'secret'}
    Object.const_set("ENV", @test_aws_credentials)
    
    @id = "test_drawing.png"
    @drawing = {:request_host => "example.com"}
  end
  
  describe "init_aws" do
    it "should establish a connection to AWS" do
      ::AWS::S3::Base.should_receive(:establish_connection!).with(
        :access_key_id     => @test_aws_credentials['S3_KEY'],
        :secret_access_key => @test_aws_credentials['S3_SECRET']
      )
      
      init_aws
    end
  end
  
  describe "save_file" do
    it "should save drawing" do
      should_receive(:init_aws)
      ::AWS::S3::S3Object.should_receive(:store).with( @id, nil, @test_bucket, :access => :public_read)

      s3_object_url = "s3_object/public/url"
      s3_object = Object.new
      s3_object.should_receive(:url).with(:authenticated => false).and_return(s3_object_url)
      ::AWS::S3::S3Object.should_receive(:find).with(@id, @test_bucket).and_return(s3_object)

      save_file(@id, @drawing[:request_host], nil).should == s3_object_url
    end
  end
  
  describe "delete_file" do
    it "should remove drawing S3 object from production env" do
      should_receive(:init_aws)
      ::AWS::S3::S3Object.should_receive(:delete).with(@id, @test_bucket)
      
      delete_file(@id)
    end
  end
end