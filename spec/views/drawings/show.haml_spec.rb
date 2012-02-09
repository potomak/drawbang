require 'spec/spec_helper'

describe "drawings/show.haml" do
  before(:each) do
    @drawing = {
      'url' => 'drawing url',
    }

    assigns[:drawing] = @drawing
  end

  it "should display @drawing['url']" do
    render("/views/drawings/show.haml")
    rendered.should match(/#{@drawing['url']}/)
  end
end