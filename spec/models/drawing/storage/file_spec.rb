require 'spec/spec_helper'

describe Storage::File do
  include Storage::File::ClassMethods
  
  before :all do
    # development env
    @test_path = "test"
    Object.const_set("DRAWINGS_PATH", @test_path)
    
    @id = "test_drawing.png"
    @drawing = {:request_host => "example.com"}
  end
  
  describe "save_file" do
    it "should save drawing" do
      file_url = "http://#{@drawing[:request_host]}/images/drawings/#{@id}"
      file = Object.new
      file.should_receive(:'<<').with(nil)
      ::File.should_receive(:open).with(::File.join(@test_path, @id), "w").and_yield(file)
      
      save_file(@id, @drawing[:request_host], nil).should == file_url
    end
  end
  
  describe "delete_file" do
    it "should remove drawing file from development env" do
      ::File.should_receive(:delete).with(::File.join(@test_path, @id))
      
      delete_file(@id)
    end
  end
end