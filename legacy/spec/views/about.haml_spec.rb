require 'spec/spec_helper'

describe "about.haml" do
  it "should display 'Credits' title" do
    render("/views/about.haml")
    rendered.should match(/Credits/)
  end
  
  it "should display app version" do
    render("/views/about.haml")
    rendered.should match(/Version: #{DRAW_VERSION}/)
  end
end