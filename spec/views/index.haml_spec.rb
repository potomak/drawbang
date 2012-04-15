require 'spec/spec_helper'

describe "index.haml" do
  it "should display 'Gallery' title" do
    render("/views/index.haml", :params => {})
    rendered.should match(/Gallery/)
  end
end